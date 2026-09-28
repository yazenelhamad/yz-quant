/**
 * Survival engine: the "earn or die" mandate. Pure functions over realised results that decide
 * how much live risk an account may take (mandate), which strategies live, die or are revived
 * (fitness / Darwinian allocation) and whether a single trade pays for itself (net expectancy).
 * Nothing here reaches a broker; the risk engine keeps its absolute veto.
 */
export * from "./types.js";
export * from "./mandate.js";
export * from "./fitness.js";
export * from "./expectancy.js";
