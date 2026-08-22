/**
 * Brand protection: never allow DSH to control its own (or DeepSeek/Harness)
 * windows. Pure logic extracted so it can be unit-tested without native deps.
 * @module
 */
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
export function brandProtected(window) {
    const title = window.title.toLowerCase();
    const cls = window.className.toLowerCase();
    const segments = window.processPath
        .toLowerCase()
        .split(/[\\/]/)
        .map((s) => s.replace(/\.(exe|com|scr|pif|bin|cmd|bat)$/i, ''));
    const dshProcess = segments.some((s) => s === 'dsh' || s === 'deepseek' || s === 'harness' ||
        s.startsWith('dsh-') || s.startsWith('dsh_') ||
        s.startsWith('deepseek-') || s.startsWith('deepseek_') ||
        s.startsWith('harness-') || s.startsWith('harness_'));
    const dshBrand = /\b(dsh|deepseek|harness)\b/.test(title);
    const dshClass = /\b(dsh|deepseek|harness)\b/.test(cls);
    return dshProcess || dshBrand || dshClass;
}
