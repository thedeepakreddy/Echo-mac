const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function run() {
  const contents = [{ role: "user", parts: [{ text: "Hello" }] }];
  try {
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });
    console.log("FIRST CALL SUCCESS");
    
    contents.push({ role: res.candidates[0].content.role || "model", parts: res.candidates[0].content.parts });
    contents.push({ role: "user", parts: [{ text: "How are you?" }] });
    
    console.log("CONTENTS BEFORE SECOND CALL:", JSON.stringify(contents, null, 2));
    
    const res2 = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: contents,
    });
    console.log("SECOND CALL SUCCESS");
  } catch (err) {
    console.error("ERROR:", err.message);
  }
}
run();
