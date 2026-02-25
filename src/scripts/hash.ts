import bcrypt from "bcrypt";

async function run() {
  const plain = process.argv[2] || "admin123";
  const hash = await bcrypt.hash(plain, 10);
  console.log(hash);
}
run();