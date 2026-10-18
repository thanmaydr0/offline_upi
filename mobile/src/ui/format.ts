export function formatInr(amountPaise: number | bigint): string {
  const paise = typeof amountPaise === 'bigint' ? amountPaise : BigInt(amountPaise);
  const rupees = paise / 100n;
  const grouped = rupees.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `₹${grouped}`;
}

export function rupeesToPaise(rupees: number): number {
  return Math.trunc(rupees) * 100;
}
