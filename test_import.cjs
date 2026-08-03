async function test() {
  const { moveMouse } = await import("./dist/tools/computer-actions.js");
  console.log("moveMouse is:", typeof moveMouse);
}
test();
