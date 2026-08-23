#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <napi.h>
#include <windows.h>
#include <objbase.h>
#include <ole2.h>
#include <uiautomation.h>
#include <gdiplus.h>
#include <psapi.h>
#include <string>
#include <vector>
#include <sstream>
#include <functional>
#include <algorithm>
#include <cstring>
#include <unordered_map>
#include <map>
#include <deque>
#include <cmath>
#include <random>

using namespace Napi;
using namespace Gdiplus;

// ---------- helpers ----------
static std::wstring utf16(const std::u16string& s) { return std::wstring(s.begin(), s.end()); }
static std::string utf8(const std::wstring& s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string r((size_t)n, 0);
  WideCharToMultiByte(CP_UTF8, 0, s.data(), (int)s.size(), r.data(), n, nullptr, nullptr);
  return r;
}
static std::wstring text(HWND h) { wchar_t b[1024]{}; GetWindowTextW(h, b, 1024); return b; }
static std::wstring cls(HWND h) { wchar_t b[512]{}; GetClassNameW(h, b, 512); return b; }
static HWND hwndOf(const CallbackInfo& i, int n = 0) { return (HWND)(UINT_PTR)i[n].ToNumber().Int64Value(); }
static RECT virtualScreenRect();

// ---------- window generation token ----------
// Every HWND we observe gets a per-window "generation" property. The property
// dies with the window, so a reused HWND value (old window destroyed, new
// window created) never inherits the old token: any observation validated
// against the old generation is rejected. This is the TOCTOU guard the
// TS-side observation validation compares.
static const wchar_t* kGenerationProp = L"DSH_CU_WINDOW_GENERATION";

static uint64_t windowGeneration(HWND h) {
  if (!IsWindow(h)) return 0;
  HANDLE v = GetPropW(h, kGenerationProp);
  if (v) return (uint64_t)(uintptr_t)v;
  // Fresh tokens are fully random (MSVC std::random_device is rand_s /
  // RtlGenRandom -- cryptographically seeded). A predictable counter let a
  // hostile process enumerate the property off live windows, predict the next
  // value and pre-set it after HWND reuse, defeating the TOCTOU guard; a
  // random 64-bit token is unguessable for a window that never carried it.
  std::random_device rd;
  uint64_t gen = 0;
  do {
    gen = ((uint64_t)rd() << 32) | (uint64_t)rd();
  } while (gen == 0); // 0 is reserved (NULL prop handle)
  SetPropW(h, kGenerationProp, (HANDLE)(uintptr_t)gen);
  return gen;
}

// ---------- stable checksums ----------
// FNV-1a 64-bit: deterministic across processes and runs (std::hash is not
// required to be stable and the review flagged it).
static uint64_t fnv1a64(const std::string& s) {
  uint64_t h = 1469598103934665603ULL;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  return h;
}
static std::string hex64(uint64_t v) {
  char b[17];
  snprintf(b, sizeof(b), "%016llx", (unsigned long long)v);
  return std::string(b);
}

// ---------- DPI ----------
static void EnsureDpiAware() {
  // PER_MONITOR_AWARE_V2 keeps GetWindowRect / BitBlt / UIA bounding rectangles
  // all in physical pixels, so window-relative screenshot coordinates match
  // injected mouse input exactly on scaled displays (150% / 200%).
  typedef BOOL (WINAPI* SetProcessDpiAwarenessContextFn)(HANDLE);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    SetProcessDpiAwarenessContextFn fn = (SetProcessDpiAwarenessContextFn)GetProcAddress(user32, "SetProcessDpiAwarenessContext");
    if (fn && fn((HANDLE)-4)) return; // PER_MONITOR_AWARE_V2
  }
  HMODULE shcore = LoadLibraryW(L"shcore.dll");
  if (shcore) {
    typedef HRESULT (WINAPI* SetProcessDpiAwarenessFn)(int);
    SetProcessDpiAwarenessFn fn = (SetProcessDpiAwarenessFn)GetProcAddress(shcore, "SetProcessDpiAwareness");
    if (fn && SUCCEEDED(fn(2))) return; // PROCESS_PER_MONITOR_DPI_AWARE
  }
  SetProcessDPIAware();
}

static UINT windowDpi(HWND h) {
  typedef UINT (WINAPI* GetDpiForWindowFn)(HWND);
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32) {
    GetDpiForWindowFn fn = (GetDpiForWindowFn)GetProcAddress(user32, "GetDpiForWindow");
    if (fn) {
      UINT dpi = fn(h);
      if (dpi) return dpi;
    }
  }
  HDC dc = GetDC(h);
  UINT dpi = dc ? (UINT)GetDeviceCaps(dc, LOGPIXELSX) : 96;
  if (dc) ReleaseDC(h, dc);
  return dpi ? dpi : 96;
}

static Object rectObj(Env e, const RECT& r) {
  Object o = Object::New(e);
  o.Set("left", r.left); o.Set("top", r.top); o.Set("right", r.right); o.Set("bottom", r.bottom);
  o.Set("width", r.right - r.left); o.Set("height", r.bottom - r.top);
  return o;
}

static bool intersectsVirtualScreen(const RECT& r) {
  RECT screen = virtualScreenRect();
  return r.right > screen.left && r.left < screen.right && r.bottom > screen.top && r.top < screen.bottom;
}

static Object identity(Env e, HWND h) {
  if (!IsWindow(h)) throw Error::New(e, "WINDOW_NOT_FOUND");
  RECT r{};
  if (!GetWindowRect(h, &r)) throw Error::New(e, "WINDOW_NOT_FOUND");
  DWORD pid = 0;
  GetWindowThreadProcessId(h, &pid);
  std::wstring path;
  HANDLE ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (ph) {
    wchar_t b[2048]{};
    DWORD n = 2048;
    if (QueryFullProcessImageNameW(ph, 0, b, &n)) path = b;
    CloseHandle(ph);
  }
  Object o = Object::New(e);
  o.Set("windowId", (double)(UINT_PTR)h);
  o.Set("title", utf8(text(h)));
  o.Set("className", utf8(cls(h)));
  // Upstream-compatible alias: the app the window belongs to (Windows class
  // name, same semantics as the original Python helper's appName field).
  o.Set("appName", utf8(cls(h)));
  o.Set("processId", (double)pid);
  o.Set("processPath", utf8(path));
  o.Set("rect", rectObj(e, r));
  o.Set("visible", (bool)IsWindowVisible(h));
  o.Set("minimized", (bool)IsIconic(h));
  o.Set("onScreen", intersectsVirtualScreen(r));
  o.Set("foreground", GetForegroundWindow() == h);
  o.Set("dpi", (double)windowDpi(h));
  o.Set("generation", (double)windowGeneration(h));
  return o;
}

static Value VerifyWindow(const CallbackInfo& info) {
  HWND h = hwndOf(info);
  uint64_t gen = info.Length() > 1 ? (uint64_t)info[1].ToNumber().Int64Value() : 0;
  if (!IsWindow(h)) return Boolean::New(info.Env(), false);
  if (gen == 0) return Boolean::New(info.Env(), true);
  return Boolean::New(info.Env(), windowGeneration(h) == gen);
}

// ---------- GDI+ singleton ----------
static ULONG_PTR gdiplusToken = 0;
static void ensureGdiplus() {
  if (gdiplusToken) return;
  GdiplusStartupInput in;
  if (GdiplusStartup(&gdiplusToken, &in, nullptr) != Ok) gdiplusToken = 0;
}

static RECT virtualScreenRect() {
  RECT r{};
  r.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  r.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  r.right = r.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  r.bottom = r.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  return r;
}

// NOTE: full-screen capture (saveScreenRect/CaptureScreen) and the screenRect
// export were removed during the 2026-08 audit: nothing in the plugin used
// them, and a full-desktop capture to a caller-supplied path would violate
// the window-isolation capture promise the plugin makes.

// ---------- window enumeration ----------
static Value ListWindows(const CallbackInfo& info) {
  Env env = info.Env();
  Array arr = Array::New(env);
  struct Ctx { Env env; Array arr; int n = 0; } ctx{env, arr};
  EnumWindows([](HWND h, LPARAM lp) -> BOOL {
    auto* c = (Ctx*)lp;
    if (IsWindowVisible(h) && !IsIconic(h) && !text(h).empty()) {
      RECT r{};
      if (GetWindowRect(h, &r) && intersectsVirtualScreen(r)) {
        try { c->arr.Set(c->n++, identity(c->env, h)); } catch (...) {}
      }
    }
    return TRUE;
  }, (LPARAM)&ctx);
  return arr;
}

static Value QueryWindow(const CallbackInfo& info) { return identity(info.Env(), hwndOf(info)); }

// ---------- input ----------
// The JavaScript event loop is blocked while a native addon call is running.
// Keep movement animation and overlay sampling in this native call so the
// cursor is visibly animated even when JS timers cannot run.
static bool moveCursorSmooth(int x, int y);

static Value Move(const CallbackInfo& info) {
  return Boolean::New(info.Env(), moveCursorSmooth(info[0].ToNumber().Int32Value(), info[1].ToNumber().Int32Value()));
}

static Value Click(const CallbackInfo& info) {
  std::string b = info[0].ToString().Utf8Value();
  DWORD down = b == "right" ? MOUSEEVENTF_RIGHTDOWN
    : b == "middle" ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_LEFTDOWN;
  DWORD up = down == MOUSEEVENTF_RIGHTDOWN ? MOUSEEVENTF_RIGHTUP
    : down == MOUSEEVENTF_MIDDLEDOWN ? MOUSEEVENTF_MIDDLEUP : MOUSEEVENTF_LEFTUP;
  int n = std::max(1, std::min(3, info[1].ToNumber().Int32Value()));
  for (int x = 0; x < n; x++) {
    INPUT in[2]{};
    in[0].type = in[1].type = INPUT_MOUSE;
    in[0].mi.dwFlags = down;
    in[1].mi.dwFlags = up;
    if (SendInput(2, in, sizeof(INPUT)) != 2) return Boolean::New(info.Env(), false);
  }
  return Boolean::New(info.Env(), true);
}

static Value TypeText(const CallbackInfo& info) {
  std::u16string s = info[0].ToString().Utf16Value();
  for (char16_t c : s) {
    INPUT in[2]{};
    in[0].type = in[1].type = INPUT_KEYBOARD;
    in[0].ki.wScan = (WORD)c;
    in[0].ki.dwFlags = KEYEVENTF_UNICODE;
    in[1].ki.wScan = (WORD)c;
    in[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
    if (SendInput(2, in, sizeof(INPUT)) != 2) return Boolean::New(info.Env(), false);
    // Pace the keystrokes; very fast injection can be dropped by slower
    // controls (the original helper injected with a 10ms per-char pause).
    Sleep(10);
  }
  return Boolean::New(info.Env(), true);
}

// ---------- clipboard ----------
// Snapshots are keyed (default "default") so concurrent or cross-session
// paste flows cannot restore the wrong content. Each entry owns its IDataObject
// and the COM initialization block it was captured under.
struct ClipboardSnapshot {
  IDataObject* data = nullptr;
  bool ownsCom = false;
};
static std::map<std::string, ClipboardSnapshot> clipboardSnapshots;
// Insertion order of live snapshot keys: sessions that die without a restore
// would otherwise pin their IDataObject (and its COM apartment) forever. The
// cap evicts the least recently saved key, bounding the leak.
static std::deque<std::string> clipboardSnapshotOrder;
const size_t kMaxClipboardSnapshots = 8;

static std::string clipboardKey(const CallbackInfo& info, int n = 0) {
  if (info.Length() > n && info[n].IsString()) return info[n].ToString().Utf8Value();
  return "default";
}

static void clearClipboardSnapshot(const std::string& key) {
  auto it = clipboardSnapshots.find(key);
  if (it == clipboardSnapshots.end()) return;
  if (it->second.data) it->second.data->Release();
  if (it->second.ownsCom) CoUninitialize();
  clipboardSnapshots.erase(it);
  for (auto o = clipboardSnapshotOrder.begin(); o != clipboardSnapshotOrder.end(); ++o) {
    if (*o == key) { clipboardSnapshotOrder.erase(o); break; }
  }
}

static void clearClipboardSnapshotsAll() {
  while (!clipboardSnapshots.empty())
    clearClipboardSnapshot(clipboardSnapshots.begin()->first);
}

static Value ClipboardSave(const CallbackInfo& info) {
  Env env = info.Env();
  std::string key = clipboardKey(info);
  clearClipboardSnapshot(key);
  while (clipboardSnapshots.size() >= kMaxClipboardSnapshots && !clipboardSnapshotOrder.empty())
    clearClipboardSnapshot(clipboardSnapshotOrder.front());
  HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  // Only a fresh S_OK init is owned; S_FALSE (already initialized) and
  // RPC_E_CHANGED_MODE (foreign apartment) must not be un-initialized here.
  const bool ownsCom = (com == S_OK);
  if (FAILED(com) && com != RPC_E_CHANGED_MODE) return Boolean::New(env, false);

  IDataObject* data = nullptr;
  HRESULT hr = OleGetClipboard(&data);
  if (FAILED(hr) || !data) {
    if (ownsCom) CoUninitialize();
    return Boolean::New(env, false);
  }
  clipboardSnapshots[key] = { data, ownsCom };
  clipboardSnapshotOrder.push_back(key);
  return Boolean::New(env, true);
}

static Value ClipboardRestore(const CallbackInfo& info) {
  Env env = info.Env();
  std::string key = clipboardKey(info);
  auto it = clipboardSnapshots.find(key);
  if (it == clipboardSnapshots.end()) return Boolean::New(env, false);
  const HRESULT hr = OleSetClipboard(it->second.data);
  const bool ok = SUCCEEDED(hr);
  clearClipboardSnapshot(key);
  return Boolean::New(env, ok);
}

// Drop every snapshot without touching the live clipboard: used on control
// session teardown so a session that died mid paste-flow cannot leak its
// captured IDataObject and COM apartment.
static Value ClipboardClearAll(const CallbackInfo& info) {
  clearClipboardSnapshotsAll();
  return Boolean::New(info.Env(), true);
}

// NOTE: ClipboardGet (read the shared system clipboard) was removed during the
// 2026-08 audit -- nothing in the plugin used it and it exported the whole
// shared clipboard to any same-process caller.

static Value ClipboardSet(const CallbackInfo& info) {
  std::u16string s = info[0].ToString().Utf16Value();
  if (!OpenClipboard(nullptr)) return Boolean::New(info.Env(), false);
  if (!EmptyClipboard()) { CloseClipboard(); return Boolean::New(info.Env(), false); }
  size_t bytes = (s.size() + 1) * sizeof(char16_t);
  HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (!hg) { CloseClipboard(); return Boolean::New(info.Env(), false); }
  void* p = GlobalLock(hg);
  if (!p) { GlobalFree(hg); CloseClipboard(); return Boolean::New(info.Env(), false); }
  memcpy(p, s.data(), bytes);
  GlobalUnlock(hg);
  if (!SetClipboardData(CF_UNICODETEXT, hg)) { GlobalFree(hg); CloseClipboard(); return Boolean::New(info.Env(), false); }
  CloseClipboard();
  return Boolean::New(info.Env(), true);
}

static Value Paste(const CallbackInfo& info) {
  INPUT in[4]{};
  in[0].type = INPUT_KEYBOARD; in[0].ki.wVk = VK_CONTROL;
  in[1].type = INPUT_KEYBOARD; in[1].ki.wVk = 'V';
  in[2].type = INPUT_KEYBOARD; in[2].ki.wVk = 'V'; in[2].ki.dwFlags = KEYEVENTF_KEYUP;
  in[3].type = INPUT_KEYBOARD; in[3].ki.wVk = VK_CONTROL; in[3].ki.dwFlags = KEYEVENTF_KEYUP;
  return Boolean::New(info.Env(), SendInput(4, in, sizeof(INPUT)) == 4);
}

// ---------- posted messages (background-safe input) ----------
static bool postPoint(HWND h, int screenX, int screenY, POINT& pt) {
  if (!IsWindow(h)) return false;
  pt.x = screenX;
  pt.y = screenY;
  return ScreenToClient(h, &pt) != FALSE;
}

static Value PostClick(const CallbackInfo& info) {
  HWND h = hwndOf(info);
  int screenX = info[1].ToNumber().Int32Value();
  int screenY = info[2].ToNumber().Int32Value();
  std::string b = info[3].ToString().Utf8Value();
  int count = std::max(1, std::min(3, info[4].ToNumber().Int32Value()));
  POINT pt{};
  if (!postPoint(h, screenX, screenY, pt)) return Boolean::New(info.Env(), false);
  LPARAM lp = MAKELPARAM(pt.x, pt.y);
  UINT move = WM_MOUSEMOVE, down = WM_LBUTTONDOWN, up = WM_LBUTTONUP;
  WPARAM downWp = MK_LBUTTON, upWp = 0;
  if (b == "right" || b == "r") { down = WM_RBUTTONDOWN; up = WM_RBUTTONUP; downWp = MK_RBUTTON; }
  else if (b == "middle" || b == "m") { down = WM_MBUTTONDOWN; up = WM_MBUTTONUP; downWp = MK_MBUTTON; }
  if (b != "left" && b != "l" && b != "right" && b != "r" && b != "middle" && b != "m") return Boolean::New(info.Env(), false);
  for (int i = 0; i < count; i++) {
    if (!PostMessageW(h, move, 0, lp) || !PostMessageW(h, down, downWp, lp)) return Boolean::New(info.Env(), false);
    Sleep(35);
    if (!PostMessageW(h, up, upWp, lp)) return Boolean::New(info.Env(), false);
    Sleep(50);
  }
  return Boolean::New(info.Env(), true);
}

static Value PostWheel(const CallbackInfo& info) {
  HWND h = hwndOf(info);
  int screenX = info[1].ToNumber().Int32Value();
  int screenY = info[2].ToNumber().Int32Value();
  int delta = info[3].ToNumber().Int32Value();
  bool horizontal = info.Length() > 4 && info[4].ToBoolean();
  POINT pt{};
  if (!postPoint(h, screenX, screenY, pt)) return Boolean::New(info.Env(), false);
  WPARAM wp = (WPARAM)((WPARAM)(WORD)delta << 16);
  return Boolean::New(info.Env(), PostMessageW(h, horizontal ? WM_MOUSEHWHEEL : WM_MOUSEWHEEL, wp, MAKELPARAM(pt.x, pt.y)) != FALSE);
}

// NOTE: PostChar (per-char WM_CHAR with an unbounded Sleep(8) pace) was
// removed during the 2026-08 audit -- it was exported but never called by the
// provider layer.

static Value Key(const CallbackInfo& info) {
  INPUT in{};
  in.type = INPUT_KEYBOARD;
  in.ki.wVk = (WORD)info[0].ToNumber().Uint32Value();
  in.ki.dwFlags = info[1].ToBoolean() ? 0 : KEYEVENTF_KEYUP;
  return Boolean::New(info.Env(), SendInput(1, &in, sizeof(in)) == 1);
}

static Value Wheel(const CallbackInfo& info) {
  int dx = info[2].ToNumber().Int32Value();
  int dy = info[3].ToNumber().Int32Value();
  INPUT in[2]{};
  int n = 0;
  if (dy) {
    in[n].type = INPUT_MOUSE;
    in[n].mi.mouseData = (DWORD)dy;
    in[n].mi.dwFlags = MOUSEEVENTF_WHEEL;
    n++;
  }
  if (dx) {
    in[n].type = INPUT_MOUSE;
    in[n].mi.mouseData = (DWORD)dx;
    in[n].mi.dwFlags = MOUSEEVENTF_HWHEEL;
    n++;
  }
  return Boolean::New(info.Env(), n == 0 || SendInput(n, in, sizeof(INPUT)) == n);
}

static Value Drag(const CallbackInfo& info) {
  if (!moveCursorSmooth(info[0].ToNumber().Int32Value(), info[1].ToNumber().Int32Value())) return Boolean::New(info.Env(), false);
  INPUT down{};
  down.type = INPUT_MOUSE;
  down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  if (SendInput(1, &down, sizeof(down)) != 1) return Boolean::New(info.Env(), false);
  bool moved = moveCursorSmooth(info[2].ToNumber().Int32Value(), info[3].ToNumber().Int32Value());
  INPUT up{};
  up.type = INPUT_MOUSE;
  up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
  bool released = SendInput(1, &up, sizeof(up)) == 1;
  return Boolean::New(info.Env(), moved && released);
}

static HWND rootWindow(HWND h) {
  HWND root = GetAncestor(h, GA_ROOT);
  return root ? root : h;
}

static bool invokeAtPoint(HWND target, int screenX, int screenY, int count) {
  if (!IsWindow(target) || !IsWindowVisible(target) || IsIconic(target)) return false;
  HWND root = rootWindow(target);
  RECT bounds{};
  if (!GetWindowRect(root, &bounds) || screenX < bounds.left || screenX >= bounds.right || screenY < bounds.top || screenY >= bounds.bottom) return false;

  HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool ownsCom = SUCCEEDED(com);
  IUIAutomation* uia = nullptr;
  bool invoked = false;
  if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia)))) {
    IUIAutomationElement* rootElement = nullptr;
    IUIAutomationCondition* condition = nullptr;
    IUIAutomationElementArray* elements = nullptr;
    if (SUCCEEDED(uia->ElementFromHandle(root, &rootElement)) && rootElement &&
        SUCCEEDED(uia->CreateTrueCondition(&condition)) && condition &&
        SUCCEEDED(rootElement->FindAll(TreeScope_Subtree, condition, &elements)) && elements) {
      int length = 0;
      elements->get_Length(&length);
      // Same order-of-magnitude bound as Uia(): walking a browser-scale tree
      // over cross-process COM blocks the JS event loop for seconds. Trees
      // that large fail closed (the foreground click path still works).
      if (length > 2000) {
        elements->Release();
        condition->Release();
        rootElement->Release();
        uia->Release();
        if (ownsCom) CoUninitialize();
        return false;
      }
      IUIAutomationElement* best = nullptr;
      long bestArea = LONG_MAX;
      for (int i = 0; i < length; i++) {
        IUIAutomationElement* candidate = nullptr;
        if (FAILED(elements->GetElement(i, &candidate)) || !candidate) continue;
        RECT candidateRect{};
        candidate->get_CurrentBoundingRectangle(&candidateRect);
        UIA_HWND elementHwnd = 0;
        candidate->get_CurrentNativeWindowHandle(&elementHwnd);
        HWND nativeElement = (HWND)(UINT_PTR)elementHwnd;
        bool inPoint = screenX >= candidateRect.left && screenX < candidateRect.right &&
          screenY >= candidateRect.top && screenY < candidateRect.bottom;
        bool sameWindow = !nativeElement || rootWindow(nativeElement) == root;
        long area = (long)std::max(0L, candidateRect.right - candidateRect.left) *
          (long)std::max(0L, candidateRect.bottom - candidateRect.top);
        IUIAutomationInvokePattern* candidateInvoke = nullptr;
        bool invokable = SUCCEEDED(candidate->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&candidateInvoke))) && candidateInvoke;
        if (inPoint && sameWindow && invokable && area < bestArea) {
          if (best) best->Release();
          best = candidate;
          bestArea = area;
          candidateInvoke->Release();
          continue;
        }
        if (candidateInvoke) candidateInvoke->Release();
        candidate->Release();
      }
      if (best) {
        IUIAutomationInvokePattern* invoke = nullptr;
        if (SUCCEEDED(best->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&invoke))) && invoke) {
          int n = std::max(1, std::min(3, count));
          invoked = true;
          for (int i = 0; i < n; i++) {
            if (FAILED(invoke->Invoke())) { invoked = false; break; }
          }
          invoke->Release();
        }
        best->Release();
      }
    }
    if (elements) elements->Release();
    if (condition) condition->Release();
    if (rootElement) rootElement->Release();
    uia->Release();
  }
  if (ownsCom) CoUninitialize();
  return invoked;
}

// ---------- element-indexed UIA actions ----------
// Mirrors the exact pre-order ControlView walk used by Uia() so the index
// emitted in the accessibility tree maps to the same element here.
static IUIAutomationElement* elementAt(IUIAutomation* uia, IUIAutomationElement* root, int target, int maxNodes, int maxDepth) {
  IUIAutomationElement* found = nullptr;
  int count = 0;
  std::function<bool(IUIAutomationElement*, int)> visit = [&](IUIAutomationElement* x, int depth) -> bool {
    if (!x || found || count >= maxNodes || depth > maxDepth) return false;
    int me = count++;
    if (me == target) { found = x; found->AddRef(); return true; }
    if (depth >= maxDepth) return false;
    IUIAutomationTreeWalker* walker = nullptr;
    if (SUCCEEDED(uia->get_ControlViewWalker(&walker))) {
      IUIAutomationElement* child = nullptr;
      walker->GetFirstChildElement(x, &child);
      while (child && !found) {
        if (visit(child, depth + 1)) {
          child->Release();
          walker->Release();
          return true;
        }
        IUIAutomationElement* next = nullptr;
        walker->GetNextSiblingElement(child, &next);
        child->Release();
        child = next;
      }
      walker->Release();
    }
    return false;
  };
  visit(root, 0);
  return found;
}

static bool invokeElementPattern(IUIAutomationElement* el, int count) {
  IUIAutomationInvokePattern* invoke = nullptr;
  if (SUCCEEDED(el->GetCurrentPatternAs(UIA_InvokePatternId, IID_PPV_ARGS(&invoke))) && invoke) {
    int n = std::max(1, std::min(3, count));
    bool ok = true;
    for (int i = 0; i < n; i++) if (FAILED(invoke->Invoke())) { ok = false; break; }
    invoke->Release();
    return ok;
  }
  IUIAutomationSelectionItemPattern* sel = nullptr;
  if (SUCCEEDED(el->GetCurrentPatternAs(UIA_SelectionItemPatternId, IID_PPV_ARGS(&sel))) && sel) {
    HRESULT hr = sel->Select();
    sel->Release();
    return SUCCEEDED(hr);
  }
  IUIAutomationTogglePattern* tog = nullptr;
  if (SUCCEEDED(el->GetCurrentPatternAs(UIA_TogglePatternId, IID_PPV_ARGS(&tog))) && tog) {
    HRESULT hr = tog->Toggle();
    tog->Release();
    return SUCCEEDED(hr);
  }
  return false;
}

static Value ElementRect(const CallbackInfo& info) {
  Env env = info.Env();
  HWND h = hwndOf(info);
  int index = info[1].ToNumber().Int32Value();
  int maxNodes = std::max(1, info[2].ToNumber().Int32Value());
  int maxDepth = std::max(1, info[3].ToNumber().Int32Value());
  HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool ownsCom = SUCCEEDED(com);
  IUIAutomation* uia = nullptr;
  IUIAutomationElement* root = nullptr;
  RECT r{};
  bool ok = false;
  if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia)))) {
    if (SUCCEEDED(uia->ElementFromHandle(h, &root)) && root) {
      IUIAutomationElement* el = elementAt(uia, root, index, maxNodes, maxDepth);
      if (el) {
        if (SUCCEEDED(el->get_CurrentBoundingRectangle(&r))) ok = true;
        el->Release();
      }
      root->Release();
    }
    uia->Release();
  }
  if (ownsCom) CoUninitialize();
  if (!ok) throw Error::New(env, "ELEMENT_NOT_FOUND");
  return rectObj(env, r);
}

static Value ElementClick(const CallbackInfo& info) {
  Env env = info.Env();
  HWND h = hwndOf(info);
  int index = info[1].ToNumber().Int32Value();
  int count = std::max(1, std::min(3, info[2].ToNumber().Int32Value()));
  int maxNodes = std::max(1, info[3].ToNumber().Int32Value());
  int maxDepth = std::max(1, info[4].ToNumber().Int32Value());
  HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool ownsCom = SUCCEEDED(com);
  IUIAutomation* uia = nullptr;
  IUIAutomationElement* root = nullptr;
  bool invoked = false;
  if (SUCCEEDED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia)))) {
    if (SUCCEEDED(uia->ElementFromHandle(h, &root)) && root) {
      IUIAutomationElement* el = elementAt(uia, root, index, maxNodes, maxDepth);
      if (el) {
        invoked = invokeElementPattern(el, count);
        el->Release();
      }
      root->Release();
    }
    uia->Release();
  }
  if (ownsCom) CoUninitialize();
  return Boolean::New(env, invoked);
}

static bool ActivateHwnd(HWND h) {
  if (!IsWindow(h)) return false;
  HWND root = rootWindow(h);
  if (IsIconic(root) || !IsWindowVisible(root)) ShowWindow(root, SW_RESTORE);
  ShowWindow(root, SW_SHOW);

  DWORD currentThread = GetCurrentThreadId();
  DWORD targetThread = GetWindowThreadProcessId(root, nullptr);
  bool active = false;
  for (int attempt = 0; attempt < 3 && !active; attempt++) {
    HWND foreground = GetForegroundWindow();
    DWORD foregroundThread = foreground ? GetWindowThreadProcessId(foreground, nullptr) : 0;
    bool attachedTarget = targetThread && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, TRUE);
    bool attachedForeground = foregroundThread && foregroundThread != currentThread && foregroundThread != targetThread && AttachThreadInput(currentThread, foregroundThread, TRUE);

    // Re-read the foreground queue on every attempt. This handles apps that
    // briefly create a modal/owned window while their main window is shown.
    // Deliberately NOT calling SetActiveWindow/SetFocus here: poking focus at
    // the frame can steal it away from the child control the user clicked
    // (e.g. the File Explorer search box), so foreground-only activation
    // preserves the existing control focus for subsequent input.
    BringWindowToTop(root);
    SetWindowPos(root, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE);
    SetForegroundWindow(root);
    SwitchToThisWindow(root, TRUE);
    SetForegroundWindow(root);
    Sleep(35);
    active = GetForegroundWindow() == root;

    if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, FALSE);
    if (attachedTarget) AttachThreadInput(currentThread, targetThread, FALSE);
  }
  return active;
}

static Value Activate(const CallbackInfo& info) { return Boolean::New(info.Env(), ActivateHwnd(hwndOf(info))); }
static Value BackgroundInvoke(const CallbackInfo& info) {
  return Boolean::New(info.Env(), invokeAtPoint(hwndOf(info), info[1].ToNumber().Int32Value(), info[2].ToNumber().Int32Value(), info[3].ToNumber().Int32Value()));
}

// ---------- capture (PNG via GDI+) ----------
// True when every pixel of a 32bpp bitmap is zero (used to detect PrintWindow
// producing a blank surface, which some drivers do instead of failing).
static bool bitmapIsBlank(HBITMAP bmp, int w, int h) {
  if (w <= 0 || h <= 0) return true;
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  std::vector<BYTE> pixels((size_t)w * h * 4, 0);
  HDC dc = GetDC(nullptr);
  int lines = dc ? GetDIBits(dc, bmp, 0, h, pixels.data(), &bi, DIB_RGB_COLORS) : 0;
  if (dc) ReleaseDC(nullptr, dc);
  if (lines != h) return false; // cannot verify -> assume not blank
  for (size_t i = 0; i < pixels.size(); i += 4) {
    if (pixels[i] || pixels[i + 1] || pixels[i + 2] || pixels[i + 3]) return false;
  }
  return true;
}

static Value Capture(const CallbackInfo& info) {
  Env env = info.Env();
  HWND h = hwndOf(info);
  if (!IsWindow(h)) return Boolean::New(env, false);
  RECT r{};
  if (!GetWindowRect(h, &r) || r.right <= r.left || r.bottom <= r.top) return Boolean::New(env, false);
  int w = r.right - r.left, hh = r.bottom - r.top;
  HDC screen = GetDC(nullptr);
  if (!screen) return Boolean::New(env, false);
  HDC mem = CreateCompatibleDC(screen);
  HBITMAP bmp = CreateCompatibleBitmap(screen, w, hh);
  if (!mem || !bmp) {
    if (bmp) DeleteObject(bmp);
    if (mem) DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return Boolean::New(env, false);
  }
  HGDIOBJ old = SelectObject(mem, bmp);
  if (!old || old == HGDI_ERROR) {
    DeleteObject(bmp);
    DeleteDC(mem);
    ReleaseDC(nullptr, screen);
    return Boolean::New(env, false);
  }
  // Window-isolated capture: PrintWindow(PW_RENDERFULLCONTENT) renders the
  // target window's own content even when it is occluded, so screenshots never
  // leak other applications (review: the old screen BitBlt+crop path included
  // whatever was drawn on top of the window). Fall back to the screen BitBlt
  // only when PrintWindow is unsupported or produced a blank surface.
  BOOL copied = PrintWindow(h, mem, PW_RENDERFULLCONTENT);
  if (copied && !bitmapIsBlank(bmp, w, hh)) {
    copied = TRUE;
  } else {
    copied = BitBlt(mem, 0, 0, w, hh, screen, r.left, r.top, SRCCOPY | CAPTUREBLT);
  }
  SelectObject(mem, old);
  DeleteDC(mem);
  ReleaseDC(nullptr, screen);
  if (!copied) {
    DeleteObject(bmp);
    return Boolean::New(env, false);
  }
  ensureGdiplus();
  if (!gdiplusToken) {
    DeleteObject(bmp);
    return Boolean::New(env, false);
  }
  std::wstring file = utf16(info[1].ToString().Utf16Value());
  bool ok = false;
  {
    Bitmap image(bmp, (HPALETTE)nullptr);
    CLSID png;
    CLSIDFromString(L"{557cf406-1a04-11d3-9a73-0000f81ef32e}", &png);
    ok = image.Save(file.c_str(), &png) == Ok;
  }
  DeleteObject(bmp);
  return Boolean::New(env, ok);
}

// ---------- UI Automation ----------
static Value Uia(const CallbackInfo& info) {
  Env env = info.Env();
  HWND h = hwndOf(info);
  int maxNodes = std::max(1, info[1].ToNumber().Int32Value());
  int maxDepth = std::max(1, info[2].ToNumber().Int32Value());
  HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool ownsCom = SUCCEEDED(com);
  IUIAutomation* uia = nullptr;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia)))) {
    if (ownsCom) CoUninitialize();
    throw Error::New(env, "UIA_PROVIDER_UNAVAILABLE");
  }
  IUIAutomationElement* root = nullptr;
  if (FAILED(uia->ElementFromHandle(h, &root))) {
    uia->Release();
    if (ownsCom) CoUninitialize();
    throw Error::New(env, "UIA_ROOT_UNAVAILABLE");
  }
  Array nodes = Array::New(env);
  std::stringstream sum;
  int count = 0;
  bool truncated = false;
  std::function<void(IUIAutomationElement*, int, int)> visit;
  visit = [&](IUIAutomationElement* x, int parent, int depth) {
    if (!x) return;
    if (count >= maxNodes || depth > maxDepth) {
      truncated = true;
      return;
    }
    BSTR name = nullptr, aid = nullptr;
    CONTROLTYPEID role = 0;
    x->get_CurrentName(&name);
    x->get_CurrentControlType(&role);
    x->get_CurrentAutomationId(&aid);
    RECT rr{};
    x->get_CurrentBoundingRectangle(&rr);
    BOOL en = FALSE, off = FALSE;
    x->get_CurrentIsEnabled(&en);
    x->get_CurrentIsOffscreen(&off);
    Object o = Object::New(env);
    o.Set("index", count);
    o.Set("parent", parent);
    o.Set("role", (double)role);
    o.Set("name", name ? utf8(name) : "");
    o.Set("automationId", aid ? utf8(aid) : "");
    o.Set("rect", rectObj(env, rr));
    o.Set("enabled", (bool)en);
    o.Set("visible", !off);
    o.Set("childCount", 0);
    nodes.Set(count, o);
    // Length-prefix the free-form strings: a name containing ':' or ';' could
    // otherwise be crafted so that two different trees serialize identically,
    // defeating the "tree unchanged" check that gates element actions.
    sum << count << ":" << parent << ":"
        << (name ? (uint64_t)SysStringLen(name) : (uint64_t)0) << ":"
        << (name ? utf8(name) : "") << ":"
        << (aid ? (uint64_t)SysStringLen(aid) : (uint64_t)0) << ":"
        << (aid ? utf8(aid) : "") << ":" << role << ":"
        << rr.left << "," << rr.top << "," << rr.right << "," << rr.bottom << ":"
        << (en ? "1" : "0") << (off ? "0" : "1") << ";";
    int me = count++;
    if (name) SysFreeString(name);
    if (aid) SysFreeString(aid);
    IUIAutomationTreeWalker* walker = nullptr;
    if (SUCCEEDED(uia->get_ControlViewWalker(&walker))) {
      IUIAutomationElement* child = nullptr;
      walker->GetFirstChildElement(x, &child);
      int cc = 0;
      if (depth >= maxDepth) {
        if (child) {
          truncated = true;
          child->Release();
        }
        o.Set("childCount", 0);
        walker->Release();
        return;
      }
      while (child && count < maxNodes) {
        visit(child, me, depth + 1);
        cc++;
        IUIAutomationElement* next = nullptr;
        walker->GetNextSiblingElement(child, &next);
        child->Release();
        child = next;
      }
      if (child) {
        truncated = true;
        child->Release();
      }
      o.Set("childCount", cc);
      walker->Release();
    }
  };
  visit(root, -1, 0);
  root->Release();
  uia->Release();
  if (ownsCom) CoUninitialize();
  Object out = Object::New(env);
  out.Set("nodes", nodes);
  out.Set("truncated", truncated);
  // FNV-1a 64-bit checksum: stable across processes/runs (std::hash is not),
  // and computed over identity + geometry + enabled/visible state.
  out.Set("checksum", hex64(fnv1a64(sum.str())));
  out.Set("mode", truncated ? "top-level" : "full");
  return out;
}

// ---------- Overlay ----------
struct GlowColor { BYTE r = 0, g = 0, b = 0; };
struct OverlayState {
  HWND hwnd = nullptr;
  int width = 0;
  int height = 0;
  double startedAt = 0;   // restrained edge motion clock (ms, QueryPerformanceCounter)
  double shownAt = 0;     // fade-in clock (ms, QueryPerformanceCounter)
  std::wstring text;
  GlowColor glowFrom{};
};
static std::unordered_map<int, OverlayState> overlays;
static int overlayNext = 1;
static int overlayVisibleCount = 0;

static double nowMs() {
  LARGE_INTEGER f, c;
  QueryPerformanceFrequency(&f);
  QueryPerformanceCounter(&c);
  return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
}

static LRESULT CALLBACK OverlayProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_NCHITTEST: return HTTRANSPARENT;
    case WM_CLOSE: return 0;
    case WM_DESTROY: return 0;
    default: return DefWindowProc(h, m, w, l);
  }
}

// The takeover signal is deliberately pinned to the DSH brand blue (the color
// the web client uses). This is NOT user-configurable: the legacy overlayColor
// setting is deprecated and has no effect on the native overlay.
static constexpr BYTE DSH_BLUE_R = 0x41, DSH_BLUE_G = 0x76, DSH_BLUE_B = 0xE6;

static void setGlowPalette(OverlayState& st) {
  st.glowFrom = { DSH_BLUE_R, DSH_BLUE_G, DSH_BLUE_B };
}

static bool renderOverlay(HWND hwnd, int w, int h, const std::wstring& t, double startedAt, double shownAt, const GlowColor& from, float fadeOut = 1.0f) {
  HDC mem = CreateCompatibleDC(nullptr);
  BITMAPINFO bi{};
  bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  bi.bmiHeader.biWidth = w;
  bi.bmiHeader.biHeight = -h;
  bi.bmiHeader.biPlanes = 1;
  bi.bmiHeader.biBitCount = 32;
  bi.bmiHeader.biCompression = BI_RGB;
  void* bits = nullptr;
  HBITMAP bmp = CreateDIBSection(mem, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  if (!bmp) { DeleteDC(mem); return false; }
  HGDIOBJ old = SelectObject(mem, bmp);
  memset(bits, 0, (size_t)w * h * 4);

  double now = nowMs();
  // Keep the boundary signal present on all four sides. A full-strength
  // traveling sine wave creates long gaps where an edge appears to vanish.
  float fadeIn = (float)std::min(1.0, (now - shownAt) / 250.0);
  float fade = std::max(0.0f, fadeIn) * std::max(0.0f, fadeOut);

  // Gaussian falloff inward from the hard screen edge. Keep the edge weights
  // directional because the top edge is easiest to lose under a title bar.
  const int BAND = 96;
  const double SIGMA2 = 2.0 * 32.0 * 32.0;
  float expT[BAND];
  for (int d = 0; d < BAND; d++) expT[d] = (float)std::exp(-((double)d * d) / SIGMA2);

  float fr = from.r, fg = from.g, fb = from.b;

  BYTE* px = (BYTE*)bits;
  for (int y = 0; y < h; y++) {
    int dTop = y, dBottom = h - 1 - y;
    bool topBand = dTop < BAND, botBand = dBottom < BAND;
    for (int x = 0; x < w; x++) {
      int dLeft = x, dRight = w - 1 - x;
      float a = 0.0f;
      if (topBand) a = std::max(a, expT[dTop] * 1.55f);
      if (botBand) a = std::max(a, expT[dBottom] * 1.16f);
      if (dLeft < BAND) a = std::max(a, expT[dLeft] * 1.30f);
      if (dRight < BAND) a = std::max(a, expT[dRight] * 1.30f);
      if (a <= 0.002f) continue;
      if (a > 1.0f) a = 1.0f;
      // Extend the corner join inward without stacking two full edge glows.
      auto cornerAt = [](int dx, int dy) {
        if (dx >= 96 || dy >= 96) return 0.0f;
        const double dist2 = (double)dx * dx + (double)dy * dy;
        return 0.24f * (float)std::exp(-dist2 / (2.0 * 46.0 * 46.0));
      };
      float corner = 0.0f;
      corner = std::max(corner, cornerAt(dTop, dLeft));
      corner = std::max(corner, cornerAt(dTop, dRight));
      corner = std::max(corner, cornerAt(dBottom, dLeft));
      corner = std::max(corner, cornerAt(dBottom, dRight));
      a = std::min(1.30f, a + corner);
      a *= fade * 0.22f;
      // The physical screen boundary can clip the first few pixels. A wider
      // inner cue keeps the position readable inside the visible desktop.
      float innerCue = 0.0f;
      auto cueAt = [](int d, float strength) {
        if (d < 10 || d > 18) return 0.0f;
        float distance = std::fabs((float)d - 14.0f);
        return strength * (1.0f - distance / 5.0f);
      };
      innerCue = std::max(innerCue, cueAt(dTop, 0.22f));
      innerCue = std::max(innerCue, cueAt(dBottom, 0.18f));
      innerCue = std::max(innerCue, cueAt(dLeft, 0.20f));
      innerCue = std::max(innerCue, cueAt(dRight, 0.20f));
      a = std::max(a, fade * innerCue);
      // A single stable color is easier to read as "DSH is in control" than a
      // background-dependent gradient.
      BYTE cr = (BYTE)std::lround(fr);
      BYTE cg = (BYTE)std::lround(fg);
      BYTE cb = (BYTE)std::lround(fb);
      BYTE aa = (BYTE)std::lround(a * 255.0f);
      size_t o = ((size_t)y * w + (size_t)x) * 4;
      px[o + 0] = (BYTE)((unsigned)cb * aa / 255);   // premultiplied straight into the DIB
      px[o + 1] = (BYTE)((unsigned)cg * aa / 255);
      px[o + 2] = (BYTE)((unsigned)cr * aa / 255);
      px[o + 3] = aa;
    }
  }

  // Compact takeover banner: one solid brand color and inverted text. It is a
  // status marker, not a second decorative glow surface.
  int bannerH = 28, bannerY = 10;
  int bannerW = std::min(360, w - 40);
  int bannerX = (w - bannerW) / 2;
  float hw = bannerW * 0.5f, hh = bannerH * 0.5f;
  float bcx = bannerX + hw, bcy = bannerY + hh;
  float br = hh;   // capsule radius = half height
  const BYTE bannerR = DSH_BLUE_R, bannerG = DSH_BLUE_G, bannerB = DSH_BLUE_B;
  BYTE bannerA = (BYTE)std::lround(202.0 * fade);
  for (int y = bannerY; y < bannerY + bannerH; y++) {
    for (int x = bannerX; x < bannerX + bannerW; x++) {
      float dx = std::fabs((float)x + 0.5f - bcx) - (hw - br);
      float dy = std::fabs((float)y + 0.5f - bcy) - (hh - br);
      float dist;
      if (dx > 0.0f || dy > 0.0f) dist = std::sqrt(std::max(dx, 0.0f) * std::max(dx, 0.0f) + std::max(dy, 0.0f) * std::max(dy, 0.0f)) - br;
      else dist = std::max(dx, dy);
      float cov = 0.5f - dist;      // 1px anti-aliased edge
      if (cov <= 0.0f) continue;
      if (cov > 1.0f) cov = 1.0f;
      BYTE a = (BYTE)std::lround((double)bannerA * cov);
      size_t o = ((size_t)y * w + (size_t)x) * 4;
      unsigned inv = 255u - a;
      px[o + 0] = (BYTE)(((unsigned)bannerB * a + (unsigned)px[o + 0] * inv) / 255u);
      px[o + 1] = (BYTE)(((unsigned)bannerG * a + (unsigned)px[o + 1] * inv) / 255u);
      px[o + 2] = (BYTE)(((unsigned)bannerR * a + (unsigned)px[o + 2] * inv) / 255u);
      px[o + 3] = (BYTE)((a * 255u + (unsigned)px[o + 3] * inv) / 255u);
    }
  }

  // Text: render glyphs black-on-transparent with GDI+ in a side bitmap and
  // use only the ALPHA channel as coverage (black is format-agnostic, so
  // GDI+'s internal premultiplication does not matter). Dark slate text.
  if (bannerA > 0 && !t.empty()) {
    HDC tdc = CreateCompatibleDC(nullptr);
    BITMAPINFO tbi{};
    tbi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    tbi.bmiHeader.biWidth = bannerW;
    tbi.bmiHeader.biHeight = -bannerH;
    tbi.bmiHeader.biPlanes = 1;
    tbi.bmiHeader.biBitCount = 32;
    tbi.bmiHeader.biCompression = BI_RGB;
    void* tbits = nullptr;
    HBITMAP tbmp = CreateDIBSection(tdc, &tbi, DIB_RGB_COLORS, &tbits, nullptr, 0);
    if (tbmp) {
      HGDIOBJ told = SelectObject(tdc, tbmp);
      memset(tbits, 0, (size_t)bannerW * bannerH * 4);
      ensureGdiplus();
      {
        Graphics tg(tdc);
        tg.SetTextRenderingHint(TextRenderingHintAntiAlias);
        Font font(L"Microsoft YaHei UI", 13, FontStyleBold, UnitPixel);
        SolidBrush black(Color(255, 0, 0, 0));
        StringFormat sf;
        sf.SetAlignment(StringAlignmentCenter);
        sf.SetLineAlignment(StringAlignmentCenter);
        RectF area(0.0f, 0.0f, (REAL)bannerW, (REAL)bannerH);
        tg.DrawString(t.c_str(), (INT)t.size(), &font, area, &sf, &black);
      }
      const BYTE tcR = 0xFF, tcG = 0xFF, tcB = 0xFF;
      BYTE* tp = (BYTE*)tbits;
      for (int y = 0; y < bannerH; y++) {
        for (int x = 0; x < bannerW; x++) {
          BYTE cov = tp[((size_t)y * bannerW + (size_t)x) * 4 + 3];
          if (!cov) continue;
          BYTE a = (BYTE)std::lround((double)cov * fade);
          if (!a) continue;
          size_t o = ((size_t)(bannerY + y) * w + (size_t)(bannerX + x)) * 4;
          unsigned inv = 255u - a;
          px[o + 0] = (BYTE)(((unsigned)tcB * a + (unsigned)px[o + 0] * inv) / 255u);
          px[o + 1] = (BYTE)(((unsigned)tcG * a + (unsigned)px[o + 1] * inv) / 255u);
          px[o + 2] = (BYTE)(((unsigned)tcR * a + (unsigned)px[o + 2] * inv) / 255u);
          px[o + 3] = (BYTE)((a * 255u + (unsigned)px[o + 3] * inv) / 255u);
        }
      }
      SelectObject(tdc, told);
      DeleteObject(tbmp);
    }
    DeleteDC(tdc);
  }

  SIZE size{ w, h };
  POINT dst{ GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN) }, src{ 0, 0 };
  BLENDFUNCTION blend{ AC_SRC_OVER, 0, 255, AC_SRC_ALPHA };
  bool ok = UpdateLayeredWindow(hwnd, nullptr, &dst, &size, mem, &src, 0, &blend, ULW_ALPHA) != FALSE;
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
  return ok;
}

static bool refreshOverlay(OverlayState& st) {
  if (!st.hwnd || st.width <= 0 || st.height <= 0) return false;
  return renderOverlay(st.hwnd, st.width, st.height, st.text, st.startedAt, st.shownAt, st.glowFrom);
}

static void refreshAllOverlays() {
  for (auto& entry : overlays) {
    OverlayState& st = entry.second;
    if (st.hwnd && IsWindowVisible(st.hwnd)) refreshOverlay(st);
  }
}

static bool moveCursorSmooth(int x, int y) {
  POINT from{};
  if (!GetCursorPos(&from)) return false;
  int distance = std::max(std::abs(x - from.x), std::abs(y - from.y));
  DWORD duration = (DWORD)std::max(120, std::min(420, 110 + distance / 5));
  int steps = std::max(2, (int)((duration + 9) / 10));

  for (int i = 1; i <= steps; i++) {
    double linear = (double)i / (double)steps;
    double eased = linear * linear * (3.0 - 2.0 * linear);
    int nextX = (int)std::lround((double)from.x + (double)(x - from.x) * eased);
    int nextY = (int)std::lround((double)from.y + (double)(y - from.y) * eased);
    if (!SetCursorPos(nextX, nextY)) return false;
    refreshAllOverlays();
    if (i != steps) Sleep(10);
  }
  return true;
}

// ---------- system cursor swap ----------
#ifndef OCR_NORMAL
#define OCR_NORMAL 32512
#endif
#ifndef OCR_IBEAM
#define OCR_IBEAM 32513
#endif
// Replaces the desktop arrow/text cursors with a larger blue DSH-style arrow while
// the overlay is visible (mirrors the original Python helper), and restores
// the system cursors via SPI_SETCURSORS once the overlay disappears.
static bool pointInPolygon(double x, double y, const std::vector<POINT>& poly) {
  bool inside = false;
  for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    double xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

static double segDist(double px, double py, double x1, double y1, double x2, double y2) {
  double dx = x2 - x1, dy = y2 - y1;
  double len2 = dx * dx + dy * dy;
  double t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0.0;
  t = std::max(0.0, std::min(1.0, t));
  double qx = x1 + t * dx, qy = y1 + t * dy;
  double ex = px - qx, ey = py - qy;
  return std::sqrt(ex * ex + ey * ey);
}

static std::wstring cursorFilePath() {
  static std::wstring path;
  if (!path.empty() && GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES) return path;
  wchar_t tmp[MAX_PATH]{};
  GetTempPathW(MAX_PATH, tmp);
  // Version the generated asset so an older cursor in the temp folder cannot
  // mask the current takeover cursor after an upgrade.
  path = std::wstring(tmp) + L"dsh-control-cursor-v4.cur";
  const int S = 56;
  // The silhouette matches the supplied 24x24 SVG scaled to a 56px canvas.
  // Its visual tip is at (7,7), which is also the CUR hotspot below.
  std::vector<POINT> poly = { {7,7},{24,47},{29,29},{47,24} };
  std::vector<BYTE> px((size_t)S * S * 4, 0);
  const int SS = 8;
  const double outlineWidth = 2.0;
  const double outlineSoftness = 0.8;
  for (int y = 0; y < S; y++) {
    for (int x = 0; x < S; x++) {
      int hits = 0;
      double outline = 0.0;
      for (int sy = 0; sy < SS; sy++) {
        for (int sx = 0; sx < SS; sx++) {
          double fx = (double)x + ((double)sx + 0.5) / SS;
          double fy = (double)y + ((double)sy + 0.5) / SS;
          if (!pointInPolygon(fx, fy, poly)) continue;
          hits++;
          double d = 1e9;
          for (size_t i = 0; i < poly.size(); i++) {
            const POINT& a = poly[i];
            const POINT& b = poly[(i + 1) % poly.size()];
            d = std::min(d, segDist(fx, fy, (double)a.x, (double)a.y, (double)b.x, (double)b.y));
          }
          // Blend the white stroke continuously instead of classifying a
          // whole pixel as white or graphite. This removes the stair-step
          // visible along the inside of the outline.
          if (d < outlineWidth + outlineSoftness) {
            double stroke = (outlineWidth + outlineSoftness - d) / outlineSoftness;
            outline += std::max(0.0, std::min(1.0, stroke));
          }
        }
      }
      if (!hits) continue;
      const double sampleCount = (double)(SS * SS);
      const double coverage = (double)hits / sampleCount;
      const double whiteCoverage = outline / sampleCount;
      const double graphiteCoverage = std::max(0.0, coverage - whiteCoverage);
      size_t o = ((size_t)y * S + (size_t)x) * 4;
      px[o + 0] = (BYTE)std::lround(0x2B * graphiteCoverage + 255.0 * whiteCoverage);   // premultiplied BGRA
      px[o + 1] = (BYTE)std::lround(0x26 * graphiteCoverage + 255.0 * whiteCoverage);
      px[o + 2] = (BYTE)std::lround(0x24 * graphiteCoverage + 255.0 * whiteCoverage);
      px[o + 3] = (BYTE)std::lround(coverage * 255.0);
    }
  }
  // CUR file layout: ICONDIR + ICONDIRENTRY (hotspot in planes/bitCount) + 32bpp DIB + AND mask.
  const DWORD imgSize = 40 + S * S * 4 + S * 4;
  std::vector<BYTE> file(22 + imgSize, 0);
  auto put16 = [&](size_t o, WORD v) { file[o] = (BYTE)(v & 0xFF); file[o + 1] = (BYTE)(v >> 8); };
  auto put32 = [&](size_t o, DWORD v) { file[o] = (BYTE)(v & 0xFF); file[o + 1] = (BYTE)((v >> 8) & 0xFF); file[o + 2] = (BYTE)((v >> 16) & 0xFF); file[o + 3] = (BYTE)((v >> 24) & 0xFF); };
  put16(0, 0); put16(2, 2); put16(4, 1);
  file[6] = (BYTE)S; file[7] = (BYTE)S;
  put16(10, 7); put16(12, 7);
  put32(14, imgSize); put32(18, 22);
  put32(22, 40); put32(26, S); put32(30, S * 2);
  put16(34, 1); put16(36, 32); put32(38, 0);
  put32(42, S * S * 4 + S * 4);
  for (int y = 0; y < S; y++) {
    const BYTE* src = &px[((size_t)(S - 1 - y) * S) * 4];
    memcpy(&file[62 + (size_t)y * S * 4], src, (size_t)S * 4);
  }
  HANDLE fh = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (fh != INVALID_HANDLE_VALUE) {
    DWORD wrote = 0;
    WriteFile(fh, file.data(), (DWORD)file.size(), &wrote, nullptr);
    CloseHandle(fh);
  }
  return path;
}

// Swap marker: while the system cursors are replaced, this file exists in
// %TEMP%. If the engine dies mid-session (crash, kill) the swap survives the
// process, so the next Init() sees the marker and restores the default
// cursors instead of leaving the user with the takeover cursor forever.
static std::wstring cursorSwapMarkerPath() {
  wchar_t tmp[MAX_PATH]{};
  GetTempPathW(MAX_PATH, tmp);
  return std::wstring(tmp) + L"dsh-cursor-swap.marker";
}

static void restoreCursorsAfterCrash() {
  const std::wstring marker = cursorSwapMarkerPath();
  if (GetFileAttributesW(marker.c_str()) == INVALID_FILE_ATTRIBUTES) return;
  SystemParametersInfoW(SPI_SETCURSORS, 0, nullptr, 0);
  DeleteFileW(marker.c_str());
}

static bool setSystemCursors(bool enabled) {
  static bool swapped = false;
  if (enabled) {
    if (swapped) return true;
    std::wstring path = cursorFilePath();
    if (path.empty()) return false;
    HCURSOR h = (HCURSOR)LoadImageW(nullptr, path.c_str(), IMAGE_CURSOR, 0, 0, LR_LOADFROMFILE);
    if (!h) return false;
    for (int sysId : { OCR_NORMAL, OCR_IBEAM }) {
      HCURSOR copy = CopyIcon(h);
      if (copy) SetSystemCursor(copy, sysId);
    }
    DestroyIcon(h);
    swapped = true;
    HANDLE fh = CreateFileW(cursorSwapMarkerPath().c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (fh != INVALID_HANDLE_VALUE) CloseHandle(fh);
    return true;
  }
  if (swapped) {
    SystemParametersInfoW(SPI_SETCURSORS, 0, nullptr, 0);
    swapped = false;
    DeleteFileW(cursorSwapMarkerPath().c_str());
  }
  return true;
}

static void overlayBecameVisible() { if (overlayVisibleCount == 0) setSystemCursors(true); overlayVisibleCount++; }
static void overlayBecameHidden() { if (overlayVisibleCount > 0) overlayVisibleCount--; if (overlayVisibleCount == 0) setSystemCursors(false); }

static Value OverlayCreate(const CallbackInfo& info) {
  Env env = info.Env();
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = OverlayProc;
  // Register the class on THIS addon's module, not the host EXE
  // (GetModuleHandleW(nullptr)): a class registered on the EXE module can be
  // pre-empted by any other component in the process registering the same
  // name with its own wndproc.
  HINSTANCE addonInstance = nullptr;
  GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                     (LPCWSTR)&OverlayProc, &addonInstance);
  wc.hInstance = addonInstance;
  wc.lpszClassName = L"DSHComputerUseOverlay";
  if (!GetClassInfoExW(wc.hInstance, wc.lpszClassName, &wc)) {
    if (!RegisterClassExW(&wc)) throw Error::New(env, "OVERLAY_REGISTER_FAILED");
  }
  HWND hwnd = CreateWindowExW(
    WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
    L"DSHComputerUseOverlay", L"", WS_POPUP,
    0, 0, 1, 1, nullptr, nullptr, wc.hInstance, nullptr);
  if (!hwnd) throw Error::New(env, "OVERLAY_CREATE_FAILED");
  OverlayState st;
  st.hwnd = hwnd;
  int id = overlayNext++;
  overlays[id] = st;
  return Number::New(env, id);
}

static Value OverlayShow(const CallbackInfo& info) {
  Env env = info.Env();
  int id = info[0].ToNumber().Int32Value();
  HWND target = hwndOf(info, 1);
  std::wstring t = utf16(info[2].ToString().Utf16Value());
  auto it = overlays.find(id);
  if (it == overlays.end()) throw Error::New(env, "OVERLAY_NOT_FOUND");
  RECT r = virtualScreenRect();
  // target == 0 means "no specific window" (list/launch tools): only the
  // virtual screen bounds must be valid.
  if ((target != 0 && !IsWindow(target)) || r.right <= r.left || r.bottom <= r.top) return Boolean::New(env, false);
  int w = r.right - r.left, h = r.bottom - r.top;
  if (w <= 0 || h <= 0) return Boolean::New(env, false);
  OverlayState& st = it->second;
  if (st.width != w || st.height != h) {
    SetWindowPos(st.hwnd, HWND_TOPMOST, 0, 0, w, h, SWP_NOMOVE | SWP_NOACTIVATE);
    st.width = w;
    st.height = h;
  }
  st.text = t;
  setGlowPalette(st);
  bool wasVisible = st.hwnd && IsWindowVisible(st.hwnd);
  if (!st.startedAt) st.startedAt = nowMs();
  if (!wasVisible) st.shownAt = nowMs();
  if (!renderOverlay(st.hwnd, w, h, t, st.startedAt, st.shownAt, st.glowFrom)) return Boolean::New(env, false);
  BOOL positioned = SetWindowPos(st.hwnd, HWND_TOPMOST, r.left, r.top, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  if (!positioned) return Boolean::New(env, false);
  ShowWindow(st.hwnd, SW_SHOWNOACTIVATE);
  bool visible = IsWindowVisible(st.hwnd) != FALSE;
  if (visible && !wasVisible) overlayBecameVisible();
  return Boolean::New(env, visible);
}

static Value OverlayRefresh(const CallbackInfo& info) {
  auto it = overlays.find(info[0].ToNumber().Int32Value());
  if (it == overlays.end()) return Boolean::New(info.Env(), false);
  return Boolean::New(info.Env(), refreshOverlay(it->second));
}

static Value OverlayHide(const CallbackInfo& info) {
  Env env = info.Env();
  auto it = overlays.find(info[0].ToNumber().Int32Value());
  if (it == overlays.end()) return Boolean::New(env, false);
  OverlayState& st = it->second;
  bool wasVisible = st.hwnd && IsWindowVisible(st.hwnd);
  // fade=true renders a short fade-out before hiding; capture paths use the
  // instant variant so screenshots are not delayed by the 200ms fade.
  bool fade = info.Length() > 1 ? info[1].ToBoolean() : false;
  if (fade && wasVisible) {
    for (int i = 1; i <= 8; i++) {
      if (!renderOverlay(st.hwnd, st.width, st.height, st.text, st.startedAt, st.shownAt, st.glowFrom, 1.0f - (float)i / 8.0f)) break;
      Sleep(25);
    }
  }
  ShowWindow(st.hwnd, SW_HIDE);
  st.startedAt = 0;
  st.shownAt = 0;
  if (wasVisible) overlayBecameHidden();
  return Boolean::New(env, true);
}

static Value OverlayDestroy(const CallbackInfo& info) {
  Env env = info.Env();
  int id = info[0].ToNumber().Int32Value();
  auto it = overlays.find(id);
  if (it == overlays.end()) return Boolean::New(env, false);
  if (it->second.hwnd) {
    if (IsWindowVisible(it->second.hwnd)) overlayBecameHidden();
    DestroyWindow(it->second.hwnd);
  }
  overlays.erase(it);
  return Boolean::New(env, true);
}

static Value RestoreCursors(const CallbackInfo& info) {
  setSystemCursors(false);
  return Boolean::New(info.Env(), true);
}

// ---------- module ----------
Object Init(Env env, Object exports) {
  EnsureDpiAware();
  restoreCursorsAfterCrash();
  exports.Set("listWindows", Function::New(env, ListWindows));
  exports.Set("getWindow", Function::New(env, QueryWindow));
  exports.Set("verifyWindow", Function::New(env, VerifyWindow));
  exports.Set("captureWindow", Function::New(env, Capture));
  exports.Set("activateWindow", Function::New(env, Activate));
  exports.Set("invokeAtPoint", Function::New(env, BackgroundInvoke));
  exports.Set("elementClick", Function::New(env, ElementClick));
  exports.Set("elementRect", Function::New(env, ElementRect));
  exports.Set("moveCursor", Function::New(env, Move));
  exports.Set("click", Function::New(env, Click));
  exports.Set("typeText", Function::New(env, TypeText));
  exports.Set("pressKey", Function::New(env, Key));
  exports.Set("scroll", Function::New(env, Wheel));
  exports.Set("drag", Function::New(env, Drag));
  exports.Set("postClick", Function::New(env, PostClick));
  exports.Set("postWheel", Function::New(env, PostWheel));
  exports.Set("saveClipboard", Function::New(env, ClipboardSave));
  exports.Set("restoreClipboard", Function::New(env, ClipboardRestore));
  exports.Set("clearClipboardSnapshots", Function::New(env, ClipboardClearAll));
  exports.Set("setClipboardText", Function::New(env, ClipboardSet));
  exports.Set("paste", Function::New(env, Paste));
  exports.Set("accessibilityTree", Function::New(env, Uia));
  exports.Set("overlayCreate", Function::New(env, OverlayCreate));
  exports.Set("overlayShow", Function::New(env, OverlayShow));
  exports.Set("overlayRefresh", Function::New(env, OverlayRefresh));
  exports.Set("overlayHide", Function::New(env, OverlayHide));
  exports.Set("overlayDestroy", Function::New(env, OverlayDestroy));
  exports.Set("restoreSystemCursors", Function::New(env, RestoreCursors));
  return exports;
}
NODE_API_MODULE(dsh_computer_use_native, Init)
