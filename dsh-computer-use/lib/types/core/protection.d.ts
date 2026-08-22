/**
 * Brand protection: never allow DSH to control its own (or DeepSeek/Harness)
 * windows. Pure logic extracted so it can be unit-tested without native deps.
 * @module
 */
/** Minimal window identity fields needed by the brand matcher. */
export interface BrandedWindowInput {
    title: string;
    className: string;
    processPath: string;
}
/**
 * True when a window belongs to DSH / DeepSeek / Harness.
 *
 * Process-path segments are matched (not substrings) so a program living in a
 * folder like `dsh-stuff` or `mysandsh` is not mistaken for DSH itself. The
 * executable extension is stripped per segment so a bare `dsh.exe` /
 * `deepseek.exe` process is recognized as DSH too. Titles match whole words:
 * `dsh`, `deepseek` or `harness` anywhere in the title (e.g. a console titled
 * `node D:\DSH\engine`) marks the window protected — over-blocking a random
 * window is the safe direction for a self-control guard.
 */
export declare function brandProtected(window: BrandedWindowInput): boolean;
