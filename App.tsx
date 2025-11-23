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
  Loader2,
  MoveHorizontal
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
  const [isUploading, setIsUploading] = useState<boolean>(false); 
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // --- Slider State ---
  const [sliderPosition, setSliderPosition] = useState<number>(50); // 0 to 100%
  const [isDraggingSlider, setIsDraggingSlider] = useState<boolean>(false);

  // --- Canvas Refs ---
  // Display canvas (visible to user)
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  // Hidden canvas storing the finalized STITCHED composite (Full Reference + Feathered Patch)
  const offscreenResultRef = useRef<HTMLCanvasElement | null>(null);
  // Cache the Reference Image element so we don't reload it every render frame
  const refImageElementRef = useRef<HTMLImageElement | null>(null);
  
  // Refs for file inputs
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

  // --- Stitching & Rendering Logic ---

  // Helper to load image
  const loadImage = (src: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image data"));
        img.src = src;
    });
  };

  // 1. STITCH GENERATION
  // Runs ONLY when a new result comes in. 
  // Creates the 'offscreenResultRef' containing the seamlessly blended final image.
  useEffect(() => {
    if (!resultImage || !referenceImage || !selection) return;

    let isMounted = true;

    const createComposite = async () => {
        try {
            console.log("Creating composite with feathering...");
            
            // Load base if not cached
            let baseImg = refImageElementRef.current;
            if (!baseImg || baseImg.src !== referenceImage) {
                baseImg = await loadImage(referenceImage);
                refImageElementRef.current = baseImg;
            }

            const patchImg = await loadImage(resultImage);

            if (!isMounted) return;

            // Prepare Offscreen Canvas for the Final Composite
            const canvas = document.createElement('canvas');
            canvas.width = baseImg.naturalWidth;
            canvas.height = baseImg.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            // A. Draw Background (Original)
            ctx.drawImage(baseImg, 0, 0);

            // B. Prepare Feathered Patch
            // We create a soft alpha mask (vignette) to blend the edges
            const patchW = patchImg.naturalWidth;
            const patchH = patchImg.naturalHeight;
            
            const patchCanvas = document.createElement('canvas');
            patchCanvas.width = patchW;
            patchCanvas.height = patchH;
            const pCtx = patchCanvas.getContext('2d');
            if (!pCtx) return;

            // Draw raw patch
            pCtx.drawImage(patchImg, 0, 0);

            // Mask Logic (Destination-In)
            // Keep opaque center, fade edges to transparent
            pCtx.globalCompositeOperation = 'destination-in';

            const maskCanvas = document.createElement('canvas');
            maskCanvas.width = patchW;
            maskCanvas.height = patchH;
            const mCtx = maskCanvas.getContext('2d');
            if (!mCtx) return;

            // Feathering Amount (15% of size) prevents hard lines
            const feather = Math.min(patchW, patchH) * 0.15;

            // Clear mask (transparent)
            mCtx.clearRect(0, 0, patchW, patchH);
            
            // 1. Solid Center
            mCtx.fillStyle = 'white';
            mCtx.fillRect(feather, feather, patchW - (feather * 2), patchH - (feather * 2));

            // 2. Gradients for Edges
            const drawGradient = (x: number, y: number, w: number, h: number, x0: number, y0: number, x1: number, y1: number) => {
                const g = mCtx.createLinearGradient(x0, y0, x1, y1);
                g.addColorStop(0, 'rgba(255,255,255,0)');
                g.addColorStop(1, 'rgba(255,255,255,1)');
                mCtx.fillStyle = g;
                mCtx.fillRect(x, y, w, h);
            };

            // Top
            drawGradient(feather, 0, patchW - feather*2, feather, 0, 0, 0, feather);
            // Bottom
            drawGradient(feather, patchH - feather, patchW - feather*2, feather, 0, patchH, 0, patchH - feather);
            // Left
            drawGradient(0, feather, feather, patchH - feather*2, 0, 0, feather, 0);
            // Right
            drawGradient(patchW - feather, feather, feather, patchH - feather*2, patchW, 0, patchW - feather, 0);

            // 3. Corners (Radial)
            const drawCorner = (cx: number, cy: number, rx: number, ry: number) => {
                const g = mCtx.createRadialGradient(cx, cy, 0, cx, cy, feather);
                g.addColorStop(0, 'rgba(255,255,255,1)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                mCtx.fillStyle = g;
                mCtx.fillRect(rx, ry, feather, feather);
            };
            drawCorner(feather, feather, 0, 0); // TL
            drawCorner(patchW - feather, feather, patchW - feather, 0); // TR
            drawCorner(feather, patchH - feather, 0, patchH - feather); // BL
            drawCorner(patchW - feather, patchH - feather, patchW - feather, patchH - feather); // BR

            // Apply Mask to Patch
            pCtx.drawImage(maskCanvas, 0, 0);

            // C. Draw Feathered Patch onto Composite
            // Use high quality interpolation
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            const targetX = Math.round(selection.x);
            const targetY = Math.round(selection.y);
            const targetW = Math.round(selection.width);
            const targetH = Math.round(selection.height);

            ctx.drawImage(patchCanvas, targetX, targetY, targetW, targetH);

            // Store result
            offscreenResultRef.current = canvas;
            
            // Force a re-render of the display
            requestAnimationFrame(renderDisplay);

        } catch (err) {
            console.error("Composite generation failed:", err);
            setError("Failed to create comparison view.");
        }
    };

    createComposite();

    return () => { isMounted = false; };
  }, [resultImage, referenceImage, selection]);


  // 2. DISPLAY RENDERING (The Slider Loop)
  // Runs whenever slider moves or composite is ready
  const renderDisplay = () => {
    const canvas = displayCanvasRef.current;
    if (!canvas || !referenceImage) return;

    // Use cached reference or fail silently (it handles resize on next frame)
    const baseImg = refImageElementRef.current;
    if (!baseImg) return;

    canvas.width = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    
    // Draw "Before" (Original Reference) - Full Size
    ctx.drawImage(baseImg, 0, 0);

    // If we have a result, draw "After" clipped by slider
    if (offscreenResultRef.current && resultImage) {
        const splitX = w * (sliderPosition / 100);

        ctx.save();
        ctx.beginPath();
        // Clip the right side to show the "After" image
        // Wait, standard slider: Left = Before? Or Left = After?
        // Usually: Left = Original, Right = Processed.
        // Let's do: 0 to splitX = Original. splitX to width = Result.
        
        // Actually, user requested "Before / After".
        // Let's assume Left Side = Original, Right Side = Result.
        // So we draw Result, but clip it to start at splitX.
        
        // REVERSE: Standard comparison sliders often show "After" on Left and "Before" on Right, or vice versa.
        // Let's implement: Left Side (0 to splitX) = RESULT (New). Right Side = REFERENCE (Old).
        // This feels impactful. "Unveil" the change.
        
        ctx.rect(0, 0, splitX, h);
        ctx.clip();
        ctx.drawImage(offscreenResultRef.current, 0, 0);
        ctx.restore();

        // Draw Divider Line
        ctx.beginPath();
        ctx.moveTo(splitX, 0);
        ctx.lineTo(splitX, h);
        ctx.lineWidth = 4 * (baseImg.naturalWidth / 800); // Scale line width with image
        ctx.strokeStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 10;
        ctx.stroke();
    }
  };

  // Re-render when slider moves
  useEffect(() => {
    renderDisplay();
  }, [sliderPosition, resultImage]);


  // --- Helper Functions ---

  const resizeImage = (file: File, maxWidth = 1024): Promise<string> => {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new Error("Image processing timed out")), 10000);
        const reader = new FileReader();
        reader.onload = (event) => {
            const result = event.target?.result;
            if (typeof result !== 'string') return;

            const img = new Image();
            img.onload = () => {
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
                if (ctx) {
                    ctx.drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/png'));
                }
                clearTimeout(timeoutId);
            };
            img.src = result;
        };
        reader.readAsDataURL(file);
    });
  };

  const getCroppedImg = (imageSrc: string, pixelCrop: SelectionBox): Promise<string> => {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.src = imageSrc;
      image.onload = () => {
        const canvas = document.createElement('canvas');
        let targetWidth = Math.round(pixelCrop.width);
        let targetHeight = Math.round(pixelCrop.height);
        
        // Cap at 1024 for API efficiency
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

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(image, pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = (e) => reject(e);
    });
  };

  // --- Handlers ---

  const handleCharacterUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setIsUploading(true);
      setError(null);
      try {
        const file = e.target.files[0];
        let resizedBase64 = await resizeImage(file, 1024);
        setCharacterImage(resizedBase64);
      } catch (err) {
        console.error("Failed to process image", err);
        setError("Failed to process character image. Please try a different file.");
      } finally {
        setIsUploading(false);
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
          // Clear cached element
          refImageElementRef.current = null;
          setSelection(null); 
          setResultImage(null);
          setSliderPosition(50);
          setIsUploading(false);
        }
      };
      reader.readAsDataURL(e.target.files[0]);
      if (refInputRef.current) refInputRef.current.value = '';
    }
  };

  const handleGenerate = async () => {
    if (!characterImage || !referenceImage || !selection) {
      setError("Please upload both images and select a region.");
      return;
    }
    if (selection.width <= 0 || selection.height <= 0) return;
    
    // Check Key
    if (!apiKeyReady && !process.env.API_KEY) {
        if (window.aistudio) {
            await window.aistudio.openSelectKey();
            const hasKey = await window.aistudio.hasSelectedApiKey();
            setApiKeyReady(hasKey);
            if (!hasKey) {
                setError("No API Key selected.");
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
      const intSelection = {
        x: Math.round(selection.x),
        y: Math.round(selection.y),
        width: Math.round(selection.width),
        height: Math.round(selection.height)
      };

      const cropBase64 = await getCroppedImg(referenceImage, intSelection);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error("Request timed out. The model is experiencing high traffic.")), 90000)
      );

      const generatedImageBase64 = await Promise.race([
        generateFaceSwap(characterImage, cropBase64),
        timeoutPromise
      ]) as string;
      
      setResultImage(generatedImageBase64);
    } catch (err: any) {
      const msg = err.message || "";
      if (msg.includes("API Key")) setApiKeyReady(false);
      setError(msg || "Generation failed.");
    } finally {
      setIsGenerating(false);
    }
  };

  // Slider Mouse Interaction
  const handleSliderMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingSlider) {
        const rect = e.currentTarget.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        setSliderPosition((x / rect.width) * 100);
    }
  };

  const handleSliderMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only start drag if clicking near the handle or generally in the container
    setIsDraggingSlider(true);
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    setSliderPosition((x / rect.width) * 100);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100 font-sans"
        onMouseUp={() => setIsDraggingSlider(false)}
        onMouseLeave={() => setIsDraggingSlider(false)}
    >
      
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
                <button onClick={handleSelectKey} className="flex items-center px-4 py-2 text-sm font-medium text-banana-900 bg-banana-500 rounded-md hover:bg-banana-400 transition-colors shadow-[0_0_15px_rgba(245,158,11,0.3)]">
                    Connect API Key
                </button>
            ) : (
                <button onClick={handleSelectKey} className="flex items-center space-x-2 px-3 py-1.5 bg-gray-900 border border-green-900/50 rounded-full hover:bg-gray-800 transition-colors group">
                    <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                    <span className="text-xs text-green-500 font-medium group-hover:text-green-400">API Key Active</span>
                </button>
            )}
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noreferrer" className="text-gray-500 hover:text-gray-300">
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
                           <div 
                                className="relative cursor-col-resize group"
                                onMouseMove={handleSliderMouseMove}
                                onMouseDown={handleSliderMouseDown}
                           >
                               <canvas 
                                    ref={displayCanvasRef} 
                                    className="max-h-[70vh] w-auto block object-contain pointer-events-none"
                                />
                                {/* Slider Handle Overlay */}
                                <div 
                                    className="absolute inset-0 pointer-events-none"
                                    style={{
                                        // We need to position this based on the *displayed* size, 
                                        // but the canvas is w-auto / max-h.
                                        // A simple way is to use the same left % as the slider.
                                        // However, if the canvas doesn't fill the div, this might be off if we rely on the parent div's width.
                                        // The parent div is 'inline-block' or similar due to canvas being block?
                                        // Actually, let's just render the handle on the canvas in JS?
                                        // Or rely on the fact that the div wraps the canvas exactly.
                                    }}
                                >
                                    <div 
                                        className="absolute top-0 bottom-0 w-1 bg-transparent group-hover:bg-white/20 transition-colors"
                                        style={{ left: `${sliderPosition}%`, transform: 'translateX(-50%)' }}
                                    >
                                        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 bg-white/90 rounded-full shadow-lg flex items-center justify-center text-gray-800">
                                            <MoveHorizontal className="w-4 h-4" />
                                        </div>
                                    </div>
                                    
                                    {/* Labels */}
                                    <div className={`absolute bottom-4 left-4 bg-black/60 text-banana-400 text-xs px-3 py-1 rounded-full backdrop-blur transition-opacity ${sliderPosition < 10 ? 'opacity-0' : 'opacity-100'}`}>
                                        After
                                    </div>
                                    <div className={`absolute bottom-4 right-4 bg-black/60 text-gray-400 text-xs px-3 py-1 rounded-full backdrop-blur transition-opacity ${sliderPosition > 90 ? 'opacity-0' : 'opacity-100'}`}>
                                        Before
                                    </div>
                                </div>

                                <button 
                                    onClick={() => setResultImage(null)}
                                    className="absolute top-2 right-2 bg-black/70 hover:bg-black text-white p-2 rounded-full backdrop-blur-md transition-all z-20 pointer-events-auto"
                                    title="Undo / Clear Result"
                                >
                                    <RefreshCw className="w-4 h-4" />
                                </button>
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
            {/* Same source panel as before, just kept cleaner */}
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
                        </div>
                    )}
                </div>
            </div>

            <div className="h-px bg-gray-800 w-full my-2"></div>

            <div className="flex-1 flex flex-col justify-end space-y-4">
                {/* Progress Indicators */}
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
                                <button onClick={handleSelectKey} className="self-start text-xs bg-red-800/50 hover:bg-red-800 text-white px-3 py-1 rounded transition-colors">
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
            </div>
        </div>

      </main>
    </div>
  );
};

export default App;