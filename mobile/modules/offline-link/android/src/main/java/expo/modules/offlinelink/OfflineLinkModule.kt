package expo.modules.offlinelink

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.journeyapps.barcodescanner.ScanOptions
import com.journeyapps.barcodescanner.ScanIntentResult
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.io.DataInputStream
import java.io.DataOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

/** Secure, bonded RFCOMM. No Nearby Connections SDK, network socket or Play Services. */
@SuppressLint("MissingPermission")
class OfflineLinkModule : Module() {
  private val serviceId = UUID.fromString("96d2f62b-479f-4ad7-84c2-68d52d74c5b3")
  private val scanCode = 47521
  private val io = Executors.newCachedThreadPool()
  private val timers = Executors.newSingleThreadScheduledExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val slots = Semaphore(2)
  @Volatile private var server: BluetoothServerSocket? = null
  @Volatile private var session: String? = null
  @Volatile private var outgoing: BluetoothSocket? = null
  private var scanPromise: Promise? = null
  private val sockets = ConcurrentHashMap.newKeySet<BluetoothSocket>()
  private class Reply {
    val latch = CountDownLatch(1)
    @Volatile var value: String? = null
  }
  private val replies = ConcurrentHashMap<String, Reply>()

  private fun adapter() = (requireNotNull(appContext.reactContext)
    .getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
    ?.also { check(it.isEnabled) { "Turn Bluetooth on on both phones. It can stay on in airplane mode." } }
    ?: error("Bluetooth is unavailable on this phone.")

  private fun work(promise: Promise, block: () -> Any?) {
    io.execute {
      try { promise.resolve(block()) }
      catch (e: Exception) { promise.reject("OFFLINE_LINK", e.message ?: "Local connection failed", e) }
    }
  }

  private fun write(socket: BluetoothSocket, value: String) {
    val bytes = value.toByteArray(Charsets.UTF_8)
    require(bytes.size in 1..262144) { "Local message exceeds limit." }
    DataOutputStream(socket.outputStream).apply { writeInt(bytes.size); write(bytes); flush() }
  }
  private fun read(socket: BluetoothSocket): String {
    val stream = DataInputStream(socket.inputStream)
    val length = stream.readInt()
    require(length in 1..262144) { "Invalid local message length." }
    val bytes = ByteArray(length)
    stream.readFully(bytes)
    return bytes.toString(Charsets.UTF_8)
  }
  private fun close(socket: BluetoothSocket?) {
    if (socket == null) return
    sockets.remove(socket)
    try { socket.close() } catch (_: Exception) { }
  }
  private fun stop() {
    session = null
    val previous = server
    server = null
    try { previous?.close() } catch (_: Exception) { }
    sockets.toList().forEach { close(it) }
    outgoing = null
    replies.values.forEach { it.latch.countDown() }
    replies.clear()
  }

  private fun reply(event: String, expected: String, payload: String): String {
    val id = UUID.randomUUID().toString()
    val reply = Reply()
    replies[id] = reply
    try {
      main.post { sendEvent(event, mapOf("id" to id, "session" to expected, "payload" to payload)) }
      check(reply.latch.await(if (event == "hello") 15L else 90L, TimeUnit.SECONDS)) { "Receiver response timed out." }
      return reply.value ?: error("Receiver closed before verification.")
    } finally { replies.remove(id) }
  }

  private fun accept(socket: BluetoothSocket, expected: String) {
    val timeout = timers.schedule({ close(socket) }, 120, TimeUnit.SECONDS)
    try {
      val hello = JSONObject(read(socket))
      require(hello.optString("type") == "hello" && hello.optString("session") == expected && session == expected) { "Wrong receiving request." }
      val challenge = hello.getString("challenge")
      require(challenge.matches(Regex("^0x[0-9a-f]{32}$"))) { "Invalid connection challenge." }
      write(socket, reply("hello", expected, challenge))
      val proof = read(socket)
      require(session == expected) { "Receiving request changed." }
      write(socket, reply("proof", expected, proof))
    } catch (_: Exception) {
      // Only the signed application receipt can confirm payment. A disconnect is never success.
    } finally {
      timeout.cancel(false)
      close(socket)
      slots.release()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("OfflineLink")
    Events("proof", "hello", "linkError")

    AsyncFunction("scanQr") { promise: Promise ->
      if (scanPromise != null) {
        promise.reject("SCAN_BUSY", "A QR scanner is already open.", null)
      } else {
        val activity = requireNotNull(appContext.currentActivity) { "Open the app before scanning." }
        val options = ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
          .setOrientationLocked(false).setBeepEnabled(false)
          .setPrompt("Scan the receiver's OfflinePay QR · works without internet")
          .setCaptureActivity(OfflineCaptureActivity::class.java)
        scanPromise = promise
        try { activity.startActivityForResult(options.createScanIntent(activity), scanCode) }
        catch (e: Exception) { scanPromise = null; promise.reject("SCAN_FAILED", e.message, e) }
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, result ->
      if (result.requestCode == scanCode) {
        val promise = scanPromise
        scanPromise = null
        promise?.resolve(ScanIntentResult.parseActivityResult(result.resultCode, result.data).contents)
      }
    }

    AsyncFunction("openBluetoothSettings") {
      requireNotNull(appContext.currentActivity).startActivity(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pairedDevices") {
      adapter().bondedDevices.map { mapOf("address" to it.address, "name" to (it.name ?: "Paired device")) }
    }

    AsyncFunction("startReceiver") { requestId: String, promise: Promise -> work(promise) {
      require(requestId.matches(Regex("^0x[0-9a-f]{32}$"))) { "Invalid request ID." }
      stop()
      val listening = adapter().listenUsingRfcommWithServiceRecord("OfflinePay", serviceId)
      session = requestId
      server = listening
      io.execute {
        while (server === listening) {
          try {
            val socket = listening.accept()
            if (slots.tryAcquire()) {
              sockets.add(socket)
              io.execute { accept(socket, requestId) }
            } else close(socket)
          } catch (e: Exception) {
            if (server === listening) {
              main.post { sendEvent("linkError", mapOf("message" to "Bluetooth listener stopped. Turn Bluetooth on and reopen Receive.")) }
            }
            break
          }
        }
      }
      true
    } }

    AsyncFunction("connect") { address: String, requestId: String, challenge: String, promise: Promise -> work(promise) {
      close(outgoing)
      outgoing = null
      val socket = adapter().getRemoteDevice(address).createRfcommSocketToServiceRecord(serviceId)
      sockets.add(socket)
      val timeout = timers.schedule({ close(socket) }, 20, TimeUnit.SECONDS)
      try {
        socket.connect()
        write(socket, JSONObject().put("type", "hello").put("session", requestId).put("challenge", challenge).toString())
        val ready = read(socket)
        outgoing = socket
        ready
      } catch (e: Exception) { close(socket); throw e }
      finally { timeout.cancel(false) }
    } }

    AsyncFunction("sendProof") { payload: String, promise: Promise -> work(promise) {
      val socket = outgoing ?: error("Connect to the receiver first.")
      val timeout = timers.schedule({ close(socket) }, 100, TimeUnit.SECONDS)
      try { write(socket, payload); read(socket) }
      finally { timeout.cancel(false); close(socket); outgoing = null }
    } }

    AsyncFunction("respond") { id: String, payload: String ->
      val reply = replies[id]
      if (reply != null) { reply.value = payload; reply.latch.countDown() }
    }
    AsyncFunction("disconnect") { stop() }
    OnDestroy {
      stop()
      scanPromise?.reject("SCAN_CLOSED", "Scanner closed.", null)
      scanPromise = null
      io.shutdownNow()
      timers.shutdownNow()
    }
  }
}
