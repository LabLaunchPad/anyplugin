import { z } from "zod";

/**
 * Single source of truth for the three intensity modes (ponytail pattern).
 * Referenced by the manifest schema (core/src/schema/index.ts), the CLI's
 * `intensity` command (cli/src/strict-args.ts), and the runtime state file
 * schema (cli/src/state.ts) so the mode set can't drift between them.
 */
export const INTENSITY_MODES = ["conservative", "balanced", "aggressive"] as const;
export const IntensityModeSchema = z.enum(INTENSITY_MODES);
export type IntensityMode = z.infer<typeof IntensityModeSchema>;
