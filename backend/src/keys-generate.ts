import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

for (const role of ["issuer", "relayer"] as const) {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  process.stdout.write(`${role.toUpperCase()}_PRIVATE_KEY=${privateKey}\n${role.toUpperCase()}_ADDRESS=${account.address}\n`);
}
