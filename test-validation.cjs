const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "dummy" });

async function run() {
  const contents = [
    { role: "user", parts: [{ text: "Hello" }] }
  ];

  try {
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
      config: {
        systemInstruction: "You are a helpful assistant",
      }
    });
    console.log("SUCCESS");
  } catch (err) {
    console.error("ERROR 1:", err.message);
  }
}
run();
