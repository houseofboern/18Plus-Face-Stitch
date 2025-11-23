import React, { useState, useEffect, useRef } from 'react';
import { 
  Upload, 
  Scissors, 
  Wand2, 
  RefreshCw, 
  AlertTriangle, 
  CheckCircle2, 
  ImagePlus,
  ArrowRight,
  Layers,
  Info,
  Loader2
} from 'lucide-react';
import { SelectionOverlay } from './components/SelectionOverlay';
import { generateFaceSwap } from './services/geminiService';
import { AppState, SelectionBox } from './types';

// Extend window interface for the AI Studio API key picker
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
  }
}

const App: React.FC = () => {
  // --- State ---
  const [apiKeyReady, setApiKeyReady] = useState<boolean>(false);
  
  const [characterImage, setCharacterImage] = useState<string | null>(null);
  const [referenceImage, setReferenceImage] = useState<string | null>(null);
  
  // The selection on the reference image
  const [selection, setSelection] = useState<SelectionBox | null>(null);
  
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [isUploading, setIsUploading] = useState<boolean>(false); // New state for image processing
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // For managing the stitched canvas
  const stitchedCanvasRef = useRef<HTMLCanvasElement>(null);
  // Refs for file inputs to clear them after selection
  const charInputRef = useRef<HTMLInputElement>(null);
  const refInputRef = useRef<HTMLInputElement>(null);

  // --- Effects ---

  // Check API Key on mount
  useEffect(() => {
    const checkApiKey = async () => {
      try {
        if (window.aistudio) {
          const hasKey = await window.aistudio.hasSelectedApiKey();
          console.log("Startup: AI Studio Key detected?", hasKey);
          setApiKeyReady(hasKey);
        } else if (process.env.API_KEY) {
            console.log("Startup: Env Key detected");
            setApiKeyReady(true);
        }
      } catch (err) {
        console.error("Error checking API key:", err);
      }
    };
    checkApiKey();
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio) {
      try {
        await window.aistudio.openSelectKey();
        // Double check if it actually worked
        const hasKey = await window.aistudio.hasSelectedApiKey();
        console.log("User selected key. Verified?", hasKey);
        setApiKeyReady(hasKey);
        if (hasKey) setError(null);
      } catch (err) {
        console.error("Key selection failed:", err);
        setError("Failed to connect API Key. Please try again.");
      }
    }
  };

  // Stitching Logic
  useEffect(() => {
    if (!resultImage || !referenceImage || !selection) return;

    let isMounted = true;
    const canvas = stitchedCanvasRef.current;
    
    const loadImage = (src: string): Promise<HTMLImageElement> => {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error("Failed to load image data"));
            img.src = src;
        });
    };

    const performStitch = async () => {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        console.log("Starting stitch process with feathering...");

        try {
            const [baseImg, patchImg] = await Promise.all([
                loadImage(referenceImage),
                loadImage(resultImage)
            ]);

            if (!isMounted) return;

            // Set canvas size to match the original reference image
            canvas.width = baseImg.naturalWidth;
            canvas.height = baseImg.naturalHeight;

            // 1. Draw original Reference (Background)
            ctx.drawImage(baseImg, 0, 0);

            // 2. Prepare Feathered Patch
            // We create a soft alpha mask (vignette) to blend the edges of the AI patch
            // into the background, removing the "hard square" look.
            const patchW = patchImg.naturalWidth;
            const patchH = patchImg.naturalHeight;
            
            const offscreen = document.createElement('canvas');
            offscreen.width = patchW;
            offscreen.height = patchH;
            const oCtx = offscreen.getContext('2d');
            if (!oCtx) return;

            // Draw raw patch
            oCtx.drawImage(patchImg, 0, 0);

            // Create Mask
            // Use destination-in to keep only the parts we want (opaque center, transparent edges)
            oCtx.globalCompositeOperation = 'destination-in';

            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = patchW;
            maskCanvas.height = patchH;
            const mCtx = maskCanvas.getContext('2d');
            if (!mCtx) return;

            // Define feather amount (15% of the image)
            const feather = Math.min(patchW, patchH) * 0.15;

            // Clear mask
            mCtx.clearRect(0, 0, patchW, patchH);
            
            // We construct a composite gradient mask for a rounded-square vignette
            
            // Center (Opaque)
            mCtx.fillStyle = 'white';
            mCtx.fillRect(feather, feather, patchW - (feather * 2), patchH - (feather * 2));

            // Gradients for Edges
            const drawGradient = (x: number, y: number, w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
                const g = mCtx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, 'rgba(255,255,255,0)'); // Transparent at outer edge
                g.addColorStop(1, 'rgba(255,255,255,1)'); // Opaque towards center
                mCtx.fillStyle = g;
                mCtx.fillRect(x, y, w, h);
            };

            // Top Edge (fading up)
            drawGradient(feather, 0, patchW - feather*2, feather, 0, 0, 0, feather);
            // Bottom Edge (fading down)
            drawGradient(feather, patchH - feather, patchW - feather*2, feather, 0, patchH, 0, patchH - feather);
            // Left Edge (fading left)
            drawGradient(0, feather, feather, patchH - feather*2, 0, 0, feather, 0);
            // Right Edge (fading right)
            drawGradient(patchW - feather, feather, feather, patchH - feather*2, patchW, 0, patchW - feather, 0);

            // Corners (Radial for softness)
            const drawCorner = (centerX: number, centerY: number, rectX: number, rectY: number) => {
                const g = mCtx.createRadialGradient(centerX, centerY, 0, centerX, centerY, feather);
                g.addColorStop(0, 'rgba(255,255,255,1)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                mCtx.fillStyle = g;
                mCtx.fillRect(rectX, rectY, feather, feather);
            };

            // Top-Left
            drawCorner(feather, feather, 0, 0);
            // Top-Right
            drawCorner(patchW - feather, feather, patchW - feather, 0);
            // Bottom-Left
            drawCorner(feather, patchH - feather, 0, patchH - feather);
            // Bottom-Right
            drawCorner(patchW - feather, patchH - feather, patchW - feather, patchH - feather);

            // Apply the generated mask to the patch
            oCtx.drawImage(maskCanvas, 0, 0);

            // 3. Draw the Blended Patch onto the Main Canvas
            const targetX = Math.round(selection.x);
            const targetY = Math.round(selection.y);
            const targetW = Math.round(selection.width);
            const targetH = Math.round(selection.height);

            console.log(`Drawing blended patch at: ${targetX}, ${targetY}`);
            
            // Ensure high quality downscaling/upscaling
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            ctx.drawImage(
                offscreen, 
                targetX, 
                targetY, 
                targetW, 
                targetH
            );
            
            console.log("Stitch complete.");

        } catch (err) {
            console.error("Stitching failed:", err);
            if (isMounted) {
                setError("Failed to render the final result. The generated image data may be corrupted.");
            }
        }
    };

    performStitch();

    return () => {
        isMounted = false;
    };
  }, [resultImage, referenceImage, selection]);


  // --- Helper Functions ---

  const resizeImage = (file: File, maxWidth = 1024): Promise<string> => {
    return new Promise((resolve, reject) => {
        // Safety timeout in case FileReader hangs
        const timeoutId = setTimeout(() => reject(new Error("Image processing timed out")), 10000);

        const reader = new FileReader();
        reader.onload = (event) => {
            const result = event.target?.result;
            if (typeof result !== 'string') {
                clearTimeout(timeoutId);
                reject(new Error("Failed to read file data"));
                return;
            }

            const img = new Image();
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height = Math.round(height * (maxWidth / width));
                        width = maxWidth;
                    }

                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        throw new Error("Canvas context failed");
                    }
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Use PNG to preserve full quality of source faces
                    const dataUrl = canvas.toDataURL('image/png');
                    clearTimeout(timeoutId);
                    resolve(dataUrl);
                } catch (e) {
                    clearTimeout(timeoutId);
                    reject(e);
                }
            };
            img.onerror = () => {
                clearTimeout(timeoutId);
                reject(new Error("Failed to load image for resizing"));
            };
            img.src = result;
        };
        reader.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error("File reading failed"));
        };
        reader.readAsDataURL(file);
    });
  };


  // --- Handlers ---

  const handleCharacterUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setIsUploading(true);
      setError(null);
      try {
        const file = e.target.files[0];
        console.log("Processing character image:", file.name, file.type, file.size);
        
        let resizedBase64: string;
        try {
             // Try to resize
             resizedBase64 = await resizeImage(file, 1024);
        } catch (resizeErr) {
             console.warn("Resize failed, falling back to original:", resizeErr);
             // Fallback to basic read if resize fails
             resizedBase64 = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (ev) => resolve(ev.target?.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(file);
             });
        }
        
        setCharacterImage(resizedBase64);
        console.log("Character image set successfully.");
      } catch (err) {
        console.error("Failed to process image", err);
        setError("Failed to process character image. Please try a different file.");
      } finally {
        setIsUploading(false);
        // Reset input so same file can be selected again
        if (charInputRef.current) charInputRef.current.value = '';
      }
    }
  };

  const handleReferenceUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setIsUploading(true);
      const reader = new FileReader();
      reader.onload = (ev) => {
        if (typeof ev.target?.result === 'string') {
          setReferenceImage(ev.target.result);
          setSelection(null); 
          setResultImage(null);
          setIsUploading(false);
        }
      };
      reader.onerror = () => {
          setError("Failed to load reference image");
          setIsUploading(false);
      }
      reader.readAsDataURL(e.target.files[0]);
      
      // Reset input
      if (refInputRef.current) refInputRef.current.value = '';
    }
  };

  const handleGenerate = async () => {
    if (!characterImage || !referenceImage || !selection) {
      setError("Please upload both images and select a region on the reference image.");
      return;
    }

    // Safety check for empty selection
    if (selection.width <= 0 || selection.height <= 0) {
        setError("Invalid selection. Please re-select the area.");
        return;
    }
    
    // Explicit API Key check before we start
    if (!apiKeyReady && !process.env.API_KEY) {
        if (window.aistudio) {
            await window.aistudio.openSelectKey();
            const hasKey = await window.aistudio.hasSelectedApiKey();
            setApiKeyReady(hasKey);
            if (!hasKey) {
                setError("No API Key selected. Operation cancelled.");
                return;
            }
        } else {
            setError("API Key system not found.");
            return;
        }
    }

    setIsGenerating(true);
    setError(null);
    setResultImage(null);

    try {
      console.log("Preparing crop...");
      // Use Math.round to ensure the crop we send is the exact same pixel dimensions 
      // as the area we plan to overwrite.
      const intSelection = {
        ...selection,
        x: Math.round(selection.x),
        y: Math.round(selection.y),
        width: Math.round(selection.width),
        height: Math.round(selection.height)
      };

      // Get crop as PNG to preserve quality/transparency
      const cropBase64 = await getCroppedImg(referenceImage, intSelection);
      
      console.log("Sending to Gemini...");
      
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Request timed out after 90 seconds. The model is experiencing high traffic.")), 90000)
      );

      // Race the actual generation against the timeout
      const generatedImageBase64 = await Promise.race([
        generateFaceSwap(characterImage, cropBase64),
        timeoutPromise
      ]) as string;
      
      console.log("Received response from Gemini.");
      setResultImage(generatedImageBase64);
    } catch (err: any) {
      console.error(err);
      const msg = err.message || "";
      
      if (
          msg.includes("Requested entity was not found") || 
          msg.includes("403") || 
          msg.includes("PERMISSION_DENIED") ||
          msg.includes("API Key is missing")
      ) {
         if (window.aistudio) {
            setError("Access denied or API Key missing. Please reconnect your key.");
            setApiKeyReady(false);
         } else {
             setError("Permission denied. Check your API_KEY.");
         }
      } else {
        setError(msg);
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const getCroppedImg = (imageSrc: string, pixelCrop: SelectionBox): Promise<string> => {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.src = imageSrc;
      image.onload = () => {
        const canvas = document.createElement('canvas');
        
        // OPTIMIZATION: Cap max dimension at 1024px for the API payload.
        // The model (Gemini 3 Pro) typically works at 1K resolution.
        // Sending a 4K crop just wastes bandwidth and causes timeouts.
        let targetWidth = Math.round(pixelCrop.width);
        let targetHeight = Math.round(pixelCrop.height);
        const maxDim = 1024;
        
        if (targetWidth > maxDim || targetHeight > maxDim) {
            const ratio = targetWidth / targetHeight;
            if (targetWidth > targetHeight) {
                targetWidth = maxDim;
                targetHeight = Math.round(maxDim / ratio);
            } else {
                targetHeight = maxDim;
                targetWidth = Math.round(maxDim * ratio);
            }
        }

        canvas.width = targetWidth;
        canvas.height = targetHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error("Could not get canvas context"));
          return;
        }

        // Draw with high quality smoothing to ensure the downscaled crop looks good
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(
          image,
          pixelCrop.x,
          pixelCrop.y,
          pixelCrop.width,
          pixelCrop.height,
          0,
          0,
          canvas.width,
          canvas.height
        );
        // Use PNG to preserve all quality and transparency
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = (e) => reject(e);
    });
  };

  // --- Render ---

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-sans">
      
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 bg-gray-950 border-b border-gray-800">
        <div className="flex items-center space-x-3">
            <div className="bg-banana-500 p-2 rounded-lg">
                <Scissors className="w-6 h-6 text-black" />
            </div>
            <div>
                <h1 className="text-xl font-bold bg-gradient-to-r from-banana-200 to-banana-500 bg-clip-text text-transparent">
                Banana Patch
                </h1>
                <p className="text-xs text-gray-500">Precision Generative In-painting</p>
            </div>
        </div>

        <div className="flex items-center space-x-4">
            {!apiKeyReady ? (
                <button 
                    onClick={handleSelectKey}
                    className="flex items-center px-4 py-2 text-sm font-medium text-banana-900 bg-banana-500 rounded-md hover:bg-banana-400 transition-colors shadow-[0_0_15px_rgba(245,158,11,0.3)]"
                >
                    Connect API Key
                </button>
            ) : (
                <button 
                    onClick={handleSelectKey}
                    className="flex items-center space-x-2 px-3 py-1.5 bg-gray-900 border border-green-900/50 rounded-full hover:bg-gray-800 transition-colors group"
                    title="Click to change API Key"
                >
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-xs text-green-500 font-medium group-hover:text-green-400">API Key Active</span>
                </button>
            )}
            <a 
                href="https://ai.google.dev/gemini-api/docs/billing" 
                target="_blank" 
                rel="noreferrer"
                className="text-gray-500 hover:text-gray-300 transition-colors"
            >
                <Info className="w-5 h-5" />
            </a>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex flex-col lg:flex-row relative">
        
        {/* Left Panel: Reference & Stitching */}
        <div className="flex-1 bg-gray-900 relative flex flex-col border-b lg:border-b-0 lg:border-r border-gray-800">
             <div className="absolute top-4 left-4 z-10 bg-black/60 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10 flex items-center space-x-2 pointer-events-none">
                <Layers className="w-4 h-4 text-banana-400" />
                <span className="text-xs font-semibold tracking-wide uppercase text-gray-300">Target Canvas</span>
             </div>

             <div className="flex-1 p-6 flex items-center justify-center overflow-auto bg-[url('https://grainy-gradients.vercel.app/noise.svg')] bg-opacity-5">
                {!referenceImage ? (
                    <div className="text-center space-y-4">
                        <div className="w-24 h-24 rounded-2xl bg-gray-800 border-2 border-dashed border-gray-700 flex items-center justify-center mx-auto hover:border-banana-500/50 hover:bg-gray-800/80 transition-all group cursor-pointer relative">
                            <input 
                                ref={refInputRef}
                                type="file" 
                                accept="image/*" 
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                onChange={handleReferenceUpload}
                            />
                            <ImagePlus className="w-8 h-8 text-gray-500 group-hover:text-banana-500 transition-colors" />
                        </div>
                        <div>
                            <h3 className="text-lg font-medium text-gray-200">Upload Reference Body</h3>
                            <p className="text-sm text-gray-500 mt-1">This is the scene you want to modify.</p>
                        </div>
                    </div>
                ) : (
                    <div className="relative shadow-2xl rounded-sm overflow-hidden border border-gray-800 max-h-full max-w-full">
                       {resultImage ? (
                           <div className="relative">
                               <canvas 
                                    ref={stitchedCanvasRef} 
                                    className="max-h-[70vh] w-auto block object-contain"
                                />
                                <button 
                                    onClick={() => setResultImage(null)}
                                    className="absolute top-2 right-2 bg-black/70 hover:bg-black text-white p-2 rounded-full backdrop-blur-md transition-all z-20"
                                    title="Undo / Clear Result"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                </button>
                                <div className="absolute bottom-4 left-0 right-0 text-center pointer-events-none">
                                    <span className="bg-black/70 backdrop-blur-sm text-banana-400 text-xs px-3 py-1 rounded-full border border-banana-500/30 shadow-lg">
                                        Generative Patch Applied
                                    </span>
                                </div>
                           </div>
                       ) : (
                           <SelectionOverlay 
                                imageSrc={referenceImage} 
                                onSelectionChange={setSelection}
                            />
                       )}
                    </div>
                )}
             </div>

             {referenceImage && !resultImage && (
                 <div className="p-4 border-t border-gray-800 bg-gray-950/50 backdrop-blur text-center">
                    <p className="text-sm text-gray-400 flex items-center justify-center gap-2">
                        <Scissors className="w-4 h-4 text-banana-500" />
                        Drag to select the face/area to replace. Constraints: <span className="text-white font-mono">Square (1:1)</span>
                    </p>
                 </div>
             )}
        </div>

        {/* Right Panel: Source & Controls */}
        <div className="w-full lg:w-96 bg-gray-950 p-6 flex flex-col gap-6 overflow-y-auto z-10 shadow-xl">
            
            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-gray-300 uppercase tracking-wider flex items-center gap-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                        Source Face
                    </span>
                    {characterImage && (
                        <button 
                            onClick={() => {
                                setCharacterImage(null);
                                if (charInputRef.current) charInputRef.current.value = '';
                            }} 
                            className="text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                            Remove
                        </button>
                    )}
                </div>

                <div className="relative group">
                    {!characterImage ? (
                        <div className={`h-48 rounded-xl border-2 border-dashed ${isUploading ? 'border-blue-500/50 bg-gray-900' : 'border-gray-800 bg-gray-900/50 hover:bg-gray-900 hover:border-blue-500/50'} transition-all flex flex-col items-center justify-center cursor-pointer relative overflow-hidden`}>
                            <input 
                                ref={charInputRef}
                                type="file" 
                                accept="image/*" 
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                                onChange={handleCharacterUpload}
                                disabled={isUploading}
                            />
                            {isUploading ? (
                                <div className="flex flex-col items-center gap-2">
                                    <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                                    <span className="text-xs text-blue-400">Processing image...</span>
                                </div>
                            ) : (
                                <>
                                    <Upload className="w-8 h-8 text-gray-600 mb-2 group-hover:text-blue-500 transition-colors" />
                                    <span className="text-xs text-gray-500">Upload Character Face</span>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="h-48 rounded-xl overflow-hidden border border-gray-800 relative shadow-lg group">
                            <img src={characterImage} alt="Character" className="w-full h-full object-cover" />
                            {isUploading && (
                                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                                </div>
                            )}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all pointer-events-none"></div>
                        </div>
                    )}
                </div>
            </div>

            <div className="h-px bg-gray-800 w-full my-2"></div>

            <div className="flex-1 flex flex-col justify-end space-y-4">
                
                <div className="space-y-3">
                    <div className={`flex items-center space-x-3 p-3 rounded-lg border transition-all ${referenceImage ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/30 border-gray-800 opacity-50'}`}>
                        <div className={`w-2 h-2 rounded-full ${referenceImage ? 'bg-banana-500' : 'bg-gray-700'}`}></div>
                        <span className="text-sm text-gray-300">1. Reference Image</span>
                        {referenceImage && <CheckCircle2 className="w-4 h-4 text-banana-500 ml-auto" />}
                    </div>

                    <div className={`flex items-center space-x-3 p-3 rounded-lg border transition-all ${selection ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/30 border-gray-800 opacity-50'}`}>
                        <div className={`w-2 h-2 rounded-full ${selection ? 'bg-banana-500' : 'bg-gray-700'}`}></div>
                        <span className="text-sm text-gray-300">2. Select Target Area</span>
                        {selection && <CheckCircle2 className="w-4 h-4 text-banana-500 ml-auto" />}
                    </div>

                    <div className={`flex items-center space-x-3 p-3 rounded-lg border transition-all ${characterImage ? 'bg-gray-900 border-gray-700' : 'bg-gray-900/30 border-gray-800 opacity-50'}`}>
                        <div className={`w-2 h-2 rounded-full ${characterImage ? 'bg-blue-500' : 'bg-gray-700'}`}></div>
                        <span className="text-sm text-gray-300">3. Source Character</span>
                        {characterImage && <CheckCircle2 className="w-4 h-4 text-blue-500 ml-auto" />}
                    </div>
                </div>

                {error && (
                    <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg flex items-start space-x-3 animate-in fade-in slide-in-from-bottom-2">
                        <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <div className="flex flex-col gap-2 w-full">
                            <p className="text-xs text-red-200 leading-relaxed">{error}</p>
                            {!apiKeyReady && (
                                <button 
                                    onClick={handleSelectKey}
                                    className="self-start text-xs bg-red-800/50 hover:bg-red-800 text-white px-3 py-1 rounded transition-colors"
                                >
                                    Select New Key
                                </button>
                            )}
                        </div>
                    </div>
                )}

                <button
                    onClick={handleGenerate}
                    disabled={!characterImage || !referenceImage || !selection || isGenerating || isUploading}
                    className={`
                        w-full py-4 rounded-xl flex items-center justify-center space-x-2 font-bold text-lg transition-all shadow-lg
                        ${(!characterImage || !referenceImage || !selection || isGenerating || isUploading) 
                            ? 'bg-gray-800 text-gray-500 cursor-not-allowed border border-transparent' 
                            : 'bg-gradient-to-r from-banana-500 to-banana-600 text-black hover:from-banana-400 hover:to-banana-500 hover:shadow-banana-500/20 hover:scale-[1.02] active:scale-[0.98]'
                        }
                    `}
                >
                    {isGenerating ? (
                        <>
                            <RefreshCw className="w-5 h-5 animate-spin" />
                            <span>Processing...</span>
                        </>
                    ) : (
                        <>
                            <Wand2 className="w-5 h-5" />
                            <span>Run Nano Banana</span>
                            <ArrowRight className="w-5 h-5 ml-1 opacity-70" />
                        </>
                    )}
                </button>
                
                <p className="text-[10px] text-center text-gray-600">
                    Powered by gemini-3-pro-image-preview
                </p>
            </div>
        </div>

      </main>
    </div>
  );
};

export default App;