const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: "dummy" });

async function run() {
  const contents = [
    { role: "user", parts: [{ text: "Hello" }] },
    { role: "model", parts: undefined }
  ];

  try {
    await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });
    console.log("SUCCESS");
  } catch (err) {
    console.error("ERROR 2:", err.message);
  }
}
run();
