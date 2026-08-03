const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: "dummy" });

async function run() {
  const contents = [
    { role: "user", parts: [{ text: "Hello" }] },
    { text: "World" }
  ];

  try {
    await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });
    console.log("SUCCESS");
  } catch (err) {
    console.error("ERROR 1:", err.message);
  }
}
run();
