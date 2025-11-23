import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";

/**
 * Helper to retry operations with exponential backoff
 */
async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  try {
    return await fn();
  } catch (error: any) {
    // Log the error for debugging
    console.warn(`Attempt failed. Error: ${error.message || error.status}`);

    // Check for transient errors:
    const isTransient = 
      error.status === 429 ||
      error.status === 500 ||
      error.status === 502 ||
      error.status === 503 || 
      error.code === 503 || 
      error.status === 504 || 
      error.code === 504 || 
      (error.message && error.message.includes("Deadline expired")) ||
      (error.message && error.message.includes("UNAVAILABLE")) ||
      (error.message && error.message.includes("TIMEOUT")) ||
      (error.message && error.message.includes("quota"));

    if (retries > 0 && isTransient) {
      console.log(`Retrying operation... Attempts left: ${retries}. Waiting ${delay}ms.`);
      await new Promise(res => setTimeout(res, delay));
      return retry(fn, retries - 1, delay * 2); // Exponential backoff (x2)
    }
    throw error;
  }
}

/**
 * Sends the reference crop and character image to Gemini 3 Pro (Nano Banana Pro)
 * to perform a face swap/stitch operation.
 * 
 * @param characterImageBase64 The source face image (Data URL)
 * @param referenceCropBase64 The specific cropped region from the target image (Data URL)
 * @returns The generated image as a Base64 string
 */
export const generateFaceSwap = async (
  characterImageBase64: string,
  referenceCropBase64: string
): Promise<string> => {
  
  // Strict API Key check
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key is missing from environment. Please click 'Connect API Key' in the top right.");
  }

  // Log masked key for verification
  console.log(`Initializing Gemini Service. API Key present: ${apiKey.substring(0, 4)}****`);

  const ai = new GoogleGenAI({ apiKey: apiKey });
  const model = 'gemini-3-pro-image-preview';

  // Helper to strip data URL prefix if present
  const stripBase64 = (str: string) => str.includes(',') ? str.split(',')[1] : str;
  
  // Helper to extract MIME type
  const getMimeType = (str: string) => {
    const match = str.match(/^data:(.+);base64,/);
    return match ? match[1] : 'image/jpeg'; // Default to jpeg if not found
  };

  const charMime = getMimeType(characterImageBase64);
  const refMime = getMimeType(referenceCropBase64);

  const cleanCharData = stripBase64(characterImageBase64);
  const cleanRefData = stripBase64(referenceCropBase64);

  // DEBUG: Log payload size to help debug timeouts
  const charSizeKB = Math.round(cleanCharData.length / 1024);
  const refSizeKB = Math.round(cleanRefData.length / 1024);
  console.log(`Payload prepared. Char Image: ${charSizeKB}KB (${charMime}), Ref Crop: ${refSizeKB}KB (${refMime})`);
  
  if (charSizeKB > 3000 || refSizeKB > 3000) {
      console.warn("WARNING: Payload is very large (>3MB). This may cause timeouts.");
  }

  const generateOp = async () => {
    console.log("Sending request to Google GenAI...");
    
    // UPDATED PROMPT: "Photorealistic Retoucher"
    // Focuses on grain matching, lighting integration, and "invisible" seams.
    const promptText = `
      You are an expert professional retoucher specializing in photorealistic composite editing.

      INPUTS:
      - IMAGE 1 (Base Canvas): The target crop. Defines the lighting, angle, skin texture, and shadow hardness.
      - IMAGE 2 (Source Identity): The face to blend in.

      INSTRUCTIONS:
      1. IDENTITY TRANSFER: Seamlessly integrate the facial features of IMAGE 2 into the head/body of IMAGE 1.
      2. PHOTOREALISM (CRITICAL): The new face MUST match the exact lighting direction, color temperature, skin tone, ISO noise, and film grain of IMAGE 1. It must NOT look like a smooth sticker.
      3. GEOMETRY (CRITICAL): The output MUST maintain the EXACT dimensions, zoom, and composition of IMAGE 1. Do NOT crop or zoom in.
      4. EDGE CONSISTENCY: The outer 5% of pixels at the borders MUST remain identical to IMAGE 1. We will be using a soft-stitch algorithm, so the transition must be invisible at the edges.
    `;

    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [
            { text: promptText },
            // ORDER MATTERS: Target (Reference) FIRST, Source SECOND.
            {
                inlineData: {
                    mimeType: refMime,
                    data: cleanRefData
                }
            },
            {
                inlineData: {
                    mimeType: charMime,
                    data: cleanCharData
                }
            }
        ]
      },
      config: {
        imageConfig: {
            aspectRatio: "1:1",
            imageSize: "1K"
        },
        // Relax safety settings to allow face editing.
        safetySettings: [
          { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
          { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
          { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
          { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
        ],
      }
    });

    // Check for safety filters first
    const candidate = response.candidates?.[0];
    
    if (!candidate) {
       throw new Error("The model returned no candidates. The request may have been blocked entirely.");
    }

    // Specific catch for Image Safety which is distinct from Text Safety
    if (candidate.finishReason === "IMAGE_SAFETY") {
       throw new Error("Generation blocked by Image Safety filters. The combination of source/target images triggered the safety policy.");
    }

    if (candidate.finishReason === "SAFETY") {
       throw new Error("The request was blocked by general safety settings.");
    }

    // Try to find the image part
    if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
            if (part.inlineData && part.inlineData.data) {
                return `data:image/png;base64,${part.inlineData.data}`;
            }
        }
    }

    // Capture text response for debugging if image is missing
    let textResponse = "No text content returned.";
    if (candidate.content?.parts) {
        const texts = candidate.content.parts
            .filter(p => p.text)
            .map(p => p.text)
            .join(" ");
        if (texts.trim().length > 0) textResponse = texts;
    }

    const reason = candidate.finishReason || "UNKNOWN";
    console.error("Gemini Failure Info:", { reason, textResponse });

    throw new Error(`Model returned status '${reason}' but no image. Message: "${textResponse}"`);
  };

  try {
    // Retry logic with slightly reduced count to not exceed UI timeout too easily
    return await retry(generateOp, 3, 2000);
  } catch (error: any) {
    console.error("Gemini API Final Failure:", error);
    // Propagate the specific error message up
    throw error;
  }
};