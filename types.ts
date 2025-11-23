export interface SelectionBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface AppState {
    characterImage: string | null;
    referenceImage: string | null;
    selection: SelectionBox | null;
    isGenerating: boolean;
    resultImage: string | null;
    error: string | null;
}