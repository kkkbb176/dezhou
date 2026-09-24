const fs = require("fs");
const path = process.argv[2];
const start = Number(process.argv[3]);
const count = Number(process.argv[4]);
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
console.log(lines.slice(start, start + count).join("\n"));
