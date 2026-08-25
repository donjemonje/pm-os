/** Neural background images used by the app (login + sidebar). */
export const neuralBackgrounds = {
  framed: "/brand/neural-1-framed.png",
  diagonal: "/brand/neural-5-diagonal.png",
} as const;

export type NeuralBackgroundKey = keyof typeof neuralBackgrounds;
