export const VOUCHER_TYPES = {
  Voucher: [
    { name: "voucherId", type: "bytes32" }, { name: "device", type: "address" },
    { name: "usdcAmount", type: "uint256" }, { name: "inrPaise", type: "uint32" },
    { name: "expiry", type: "uint64" },
  ],
} as const;

export const PAYMENT_TYPES = {
  Payment: [
    { name: "voucherId", type: "bytes32" }, { name: "device", type: "address" },
    { name: "payee", type: "address" }, { name: "usdcAmount", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;
