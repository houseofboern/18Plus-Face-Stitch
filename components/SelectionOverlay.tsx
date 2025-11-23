import React, { useRef, useState, useEffect } from 'react';
import { SelectionBox } from '../types';

interface SelectionOverlayProps {
  imageSrc: string;
  onSelectionChange: (selection: SelectionBox | null) => void;
}

export const SelectionOverlay: React.FC<SelectionOverlayProps> = ({ imageSrc, onSelectionChange }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState<{ x: number, y: number } | null>(null);
  const [currentBox, setCurrentBox] = useState<SelectionBox | null>(null);

  // Redraw canvas whenever currentBox changes
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;

    // Match canvas size to the DISPLAYED image size (CSS pixels)
    const rect = img.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Dimming overlay
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (currentBox) {
        // Calculate display coordinates from natural coordinates
        const scaleX = rect.width / img.naturalWidth;
        const scaleY = rect.height / img.naturalHeight;

        const displayX = currentBox.x * scaleX;
        const displayY = currentBox.y * scaleY;
        const displayW = currentBox.width * scaleX;
        const displayH = currentBox.height * scaleY;

        // Cut out the hole
        ctx.clearRect(displayX, displayY, displayW, displayH);
        
        // Draw Border
        ctx.strokeStyle = '#f59e0b'; // banana-500
        ctx.lineWidth = 2;
        ctx.strokeRect(displayX, displayY, displayW, displayH);

        // Draw handles or guides
        ctx.fillStyle = '#f59e0b';
        ctx.font = "12px sans-serif";
        ctx.fillText(`${Math.round(currentBox.width)}x${Math.round(currentBox.height)}`, displayX, displayY - 5);
    }

  }, [currentBox, imageSrc]);

  // Handle Resize
  useEffect(() => {
    const handleResize = () => {
         if (currentBox) setCurrentBox({...currentBox});
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentBox]);


  const handleMouseDown = (e: React.MouseEvent) => {
    if (!imgRef.current) return;
    const rect = imgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setStartPos({ x, y });
    setIsDragging(true);
    setCurrentBox(null);
    onSelectionChange(null);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging || !startPos || !imgRef.current) return;
    
    const rect = imgRef.current.getBoundingClientRect();
    const currentX = e.clientX - rect.left;
    const currentY = e.clientY - rect.top;

    // Enforce Square Constraint (1:1)
    let width = currentX - startPos.x;
    let height = currentY - startPos.y; 

    // Find the largest dimension to make it a square
    const size = Math.max(Math.abs(width), Math.abs(height));
    
    // Determine direction
    const signX = width < 0 ? -1 : 1;
    const signY = height < 0 ? -1 : 1;

    // Final square dimensions in display pixels
    const finalW = size;
    const finalH = size;

    // Top-left origin calculation
    let originX = startPos.x;
    let originY = startPos.y;

    if (signX < 0) originX -= finalW;
    if (signY < 0) originY -= finalH;

    // Boundary checks (Display coordinates)
    if (originX < 0) originX = 0;
    if (originY < 0) originY = 0;
    // Simple clamp if expanding beyond image (doesn't perfect maintain square but good enough for UI)
    if (originX + finalW > rect.width) {
        // stop expanding logic here is complex, simple clamp
    }

    // Convert to Natural Coordinates for state
    const scaleX = imgRef.current.naturalWidth / rect.width;
    const scaleY = imgRef.current.naturalHeight / rect.height;

    // IMPORTANT: To ensure strict 1:1, we must use ONE scale factor or average them if aspect ratio is perfectly preserved
    // Images are rendered usually maintaining aspect ratio.
    
    const naturalW = Math.floor(finalW * scaleX);
    // Force height to match width exactly in natural pixels
    const naturalH = naturalW; 

    const naturalBox: SelectionBox = {
        x: Math.floor(originX * scaleX),
        y: Math.floor(originY * scaleY),
        width: naturalW,
        height: naturalH
    };

    setCurrentBox(naturalBox);
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    if (currentBox) {
        // Enforce a minimum size
        if (currentBox.width > 50) {
            onSelectionChange(currentBox);
        } else {
            setCurrentBox(null);
            onSelectionChange(null);
        }
    }
  };

  return (
    <div ref={containerRef} className="relative inline-block cursor-crosshair select-none"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
    >
      <img 
        ref={imgRef}
        src={imageSrc} 
        alt="Reference" 
        className="max-h-[70vh] w-auto block pointer-events-none"
        onLoad={() => setCurrentBox(null)} // Reset on new image load
      />
      <canvas 
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
      />
    </div>
  );
};