import { readFile } from "node:fs/promises";

import { createClientFromEnv } from "./client.js";

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current.startsWith("--")) {
      args[current] = argv[index + 1];
      index += 1;
    }
  }

  return args;
}

function printUsage() {
  console.error("Usage:");
  console.error("  node src/cli.js static --payload path/to/static.json");
  console.error("  node src/cli.js operations --payload path/to/operations.json");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || !args["--payload"]) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const payload = JSON.parse(await readFile(args["--payload"], "utf8"));
  const client = createClientFromEnv();

  let result;
  if (command === "static") {
    result = await client.updateParkingStaticInfo(payload);
  } else if (command === "operations") {
    result = await client.reportOperations(payload);
  } else {
    printUsage();
    process.exitCode = 1;
    return;
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  if (error.details) {
    console.error(JSON.stringify(error.details, null, 2));
  }
  process.exitCode = 1;
});
