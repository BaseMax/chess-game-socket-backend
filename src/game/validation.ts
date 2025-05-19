import { Chess } from "chess.js";

export function validateAndApplyMove(fen: string, move: string) {
  const chess = new Chess(fen);
  const result = chess.move(move);
  return {
    valid: !!result,
    fen: chess.fen(),
  };
}
