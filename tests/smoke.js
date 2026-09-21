// Quick smoke test of the compiled extension with a mock pi runtime.
// Not shipped with the package — only used during local validation.

const extension = require("../dist/index.js").default;

const calls = [];
const pi = {
  on(event, handler) {
    pi._handlers = pi._handlers || {};
    pi._handlers[event] = handler;
  },
  _fire(event, eventObj, ctx) {
    if (pi._handlers && pi._handlers[event]) {
      pi._handlers[event](eventObj, ctx);
    }
  },
};

const ctx = {
  ui: {
    setStatus(key, content) {
      calls.push(["setStatus", key, String(content)]);
    },
    notify(msg, level) {
      calls.push(["notify", msg, level]);
    },
  },
};

extension(pi);

console.log("--- Test 1: clean bash output (rust build success) ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "Compiling foo v0.1.0\nFinished `dev` profile [unoptimized + debuginfo] target(s) in 4.21s\n" },
  ctx,
);

console.log("--- Test 2: rust compiler error ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "error[E0425]: cannot find value `x`\n --> src/main.rs:3:5\n" },
  ctx,
);
console.log("--- Test 3: rust compiler error again (streak should hit 2) ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "error[E0423]: expected function, found `i32`\n" },
  ctx,
);
console.log("--- Test 4: third failure -> streak=3 -> notify on next turn_end ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "error[E0425]: cannot find value `y`\n" },
  ctx,
);
pi._fire("turn_end", {}, ctx); // expect notify here

console.log("--- Test 5: clean output resets streak to 0 ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "Build succeeded.\n" },
  ctx,
);

console.log("--- Test 6: ignore non-bash tools ---");
pi._fire(
  "tool_result",
  { toolName: "read", output: "error[E0425] fake error in non-bash output" },
  ctx,
);

console.log("--- Test 7: case-insensitive scan ---");
pi._fire(
  "tool_result",
  { toolName: "bash", output: "FAILED TO COMPILE in lowercase-bypass attempt\n" },
  ctx,
);

console.log("--- Now 28 more turn_ends to hit turn 30 threshold ---");
for (let i = 0; i < 28; i++) {
  pi._fire("turn_end", {}, ctx);
}

// Final turn_end to hit turn 30
pi._fire("turn_end", {}, ctx);

console.log("\n=== Captured calls ===");
for (const c of calls) console.log(JSON.stringify(c));

const lastStatus = calls.filter((c) => c[0] === "setStatus").pop();
console.log("\n=== Final status ===", lastStatus && lastStatus[2]);
