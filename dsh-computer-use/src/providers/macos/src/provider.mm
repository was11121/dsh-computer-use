// macOS native provider for dsh-computer-use.
//
// Written ahead of a real macOS build. This Objective-C++ Node-API addon
// implements the surface declared in ../native.d.ts using CoreGraphics,
// AppKit, Accessibility (AXUIElement) and NSPasteboard.
//
// NOTE: This file has NOT been compiled on macOS yet; it is an implementation
// draft that must be validated with Xcode Command Line Tools.

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreFoundation/CoreFoundation.h>
#import <napi.h>

#include <cstdio>
#include <string>
#include <vector>
#include <unistd.h>

static std::string NSStr(NSString *s) {
  if (!s) return "";
  return std::string([s UTF8String]);
}

static Napi::Value JsBool(const Napi::Env &env, bool v) {
  return Napi::Boolean::New(env, v);
}

static Napi::Value JsNumber(const Napi::Env &env, double v) {
  return Napi::Number::New(env, v);
}

static Napi::Value JsString(const Napi::Env &env, const std::string &v) {
  return Napi::String::New(env, v);
}

static Napi::Object RectToJs(const Napi::Env &env, CGRect r) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("left", JsNumber(env, r.origin.x));
  o.Set("top", JsNumber(env, r.origin.y));
  o.Set("right", JsNumber(env, r.origin.x + r.size.width));
  o.Set("bottom", JsNumber(env, r.origin.y + r.size.height));
  o.Set("width", JsNumber(env, r.size.width));
  o.Set("height", JsNumber(env, r.size.height));
  return o;
}

// Stable window id: mac:window:<ownerPid>:<windowNumber>
static std::string WindowIdFor(CGWindowID wid, pid_t pid) {
  char buf[128];
  snprintf(buf, sizeof(buf), "mac:window:%d:%u", (int)pid, (unsigned)wid);
  return std::string(buf);
}

static CGWindowID ParseWindowId(const std::string &id, pid_t *pidOut) {
  const std::string prefix = "mac:window:";
  if (id.rfind(prefix, 0) != 0) return 0;
  size_t a = prefix.size();
  size_t b = id.find(':', a);
  if (b == std::string::npos) return 0;
  *pidOut = (pid_t)std::stoi(id.substr(a, b - a));
  return (CGWindowID)std::stoul(id.substr(b + 1));
}

static NSDictionary *WindowInfo(CGWindowID wid) {
  CFArrayRef arr = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, wid);
  if (!arr) return nil;
  NSArray *windows = (__bridge NSArray *)arr;
  NSDictionary *found = nil;
  for (NSDictionary *info in windows) {
    NSNumber *number = info[(__bridge NSString *)kCGWindowNumber];
    if (number && [number unsignedIntValue] == wid) { found = info; break; }
  }
  NSDictionary *kept = nil;
  if (found) {
    kept = CFBridgingRelease(CFRetain((__bridge CFDictionaryRef)found));
  }
  CFRelease(arr);
  return kept;
}

static Napi::Value ListWindows(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  CFArrayRef arr = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  NSArray *windows = (__bridge NSArray *)arr;
  Napi::Array result = Napi::Array::New(env, [windows count]);
  NSUInteger idx = 0;
  for (NSDictionary *w in windows) {
    NSNumber *number = w[(__bridge NSString *)kCGWindowNumber];
    NSNumber *ownerPid = w[(__bridge NSString *)kCGWindowOwnerPID];
    NSString *name = w[(__bridge NSString *)kCGWindowName];
    NSString *owner = w[(__bridge NSString *)kCGWindowOwnerName];
    NSDictionary *bounds = w[(__bridge NSString *)kCGWindowBounds];
    pid_t pid = ownerPid ? (pid_t)[ownerPid intValue] : 0;
    CGWindowID wid = number ? (CGWindowID)[number unsignedIntValue] : 0;
    CGRect r = CGRectNull;
    if (bounds) {
      r.origin.x = [bounds[@"X"] doubleValue];
      r.origin.y = [bounds[@"Y"] doubleValue];
      r.size.width = [bounds[@"Width"] doubleValue];
      r.size.height = [bounds[@"Height"] doubleValue];
    }
    Napi::Object o = Napi::Object::New(env);
    o.Set("windowId", JsString(env, WindowIdFor(wid, pid)));
    o.Set("title", JsString(env, NSStr(name)));
    o.Set("appName", JsString(env, NSStr(owner)));
    o.Set("processId", JsNumber(env, pid));
    o.Set("processPath", JsString(env, ""));
    o.Set("className", JsString(env, ""));
    o.Set("rect", RectToJs(env, r));
    o.Set("visible", JsBool(env, true));
    o.Set("minimized", JsBool(env, false));
    o.Set("onScreen", JsBool(env, true));
    o.Set("foreground", JsBool(env, false));
    o.Set("dpi", JsNumber(env, 72.0));
    result.Set(idx++, o);
  }
  CFRelease(arr);
  return result;
}

static Napi::Value GetWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "windowId string expected").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  pid_t pid = 0;
  CGWindowID wid = ParseWindowId(info[0].As<Napi::String>().Utf8Value(), &pid);
  NSDictionary *w = WindowInfo(wid);
  if (!w) {
    Napi::Error::New(env, "WINDOW_NOT_FOUND").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSNumber *ownerPid = w[(__bridge NSString *)kCGWindowOwnerPID];
  // The id encodes the owner pid; the live window must still belong to it.
  if (ownerPid && pid != 0 && [ownerPid intValue] != pid) {
    Napi::Error::New(env, "WINDOW_NOT_FOUND").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSNumber *number = w[(__bridge NSString *)kCGWindowNumber];
  NSString *name = w[(__bridge NSString *)kCGWindowName];
  NSString *owner = w[(__bridge NSString *)kCGWindowOwnerName];
  NSDictionary *bounds = w[(__bridge NSString *)kCGWindowBounds];
  CGRect r = CGRectNull;
  if (bounds) {
    r.origin.x = [bounds[@"X"] doubleValue];
    r.origin.y = [bounds[@"Y"] doubleValue];
    r.size.width = [bounds[@"Width"] doubleValue];
    r.size.height = [bounds[@"Height"] doubleValue];
  }
  Napi::Object o = Napi::Object::New(env);
  o.Set("windowId", JsString(env, WindowIdFor(number ? [number unsignedIntValue] : 0, ownerPid ? [ownerPid intValue] : 0)));
  o.Set("title", JsString(env, NSStr(name)));
  o.Set("appName", JsString(env, NSStr(owner)));
  o.Set("processId", JsNumber(env, ownerPid ? [ownerPid intValue] : 0));
  o.Set("processPath", JsString(env, ""));
  o.Set("className", JsString(env, ""));
  o.Set("rect", RectToJs(env, r));
  o.Set("visible", JsBool(env, true));
  o.Set("minimized", JsBool(env, false));
  o.Set("onScreen", JsBool(env, true));
  o.Set("foreground", JsBool(env, false));
  o.Set("dpi", JsNumber(env, 72.0));
  return o;
}

static Napi::Value CaptureWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  CGWindowID wid = ParseWindowId(info[0].As<Napi::String>().Utf8Value(), &pid);
  std::string path = info[1].As<Napi::String>().Utf8Value();
  CGImageRef image = CGWindowListCreateImage(CGRectNull, kCGWindowListOptionIncludingWindow, wid,
      kCGWindowImageBoundsIgnoreFraming | kCGWindowImageShouldBeOpaque);
  if (!image) {
    Napi::Error::New(env, "NATIVE_CAPTURE_FAILED").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:image];
  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  BOOL ok = [png writeToFile:[NSString stringWithUTF8String:path.c_str()] atomically:YES];
  CGImageRelease(image);
  return JsBool(env, ok);
}

static AXUIElementRef FindAXWindow(pid_t pid, CGRect bounds) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return NULL;
  CFArrayRef wins = NULL;
  AXUIElementRef match = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&wins) == kAXErrorSuccess && wins) {
    CFIndex n = CFArrayGetCount(wins);
    CGFloat bestDist = CGFLOAT_MAX;
    for (CFIndex i = 0; i < n; i++) {
      AXUIElementRef win = (AXUIElementRef)CFArrayGetValueAtIndex(wins, i);
      CGPoint pos = CGPointZero;
      CGSize size = CGSizeZero;
      CFTypeRef posRef = NULL, sizeRef = NULL;
      if (AXUIElementCopyAttributeValue(win, kAXPositionAttribute, &posRef) == kAXErrorSuccess && posRef) {
        AXValueGetValue((AXValueRef)posRef, kAXValueCGPointType, &pos);
        CFRelease(posRef);
      }
      if (AXUIElementCopyAttributeValue(win, kAXSizeAttribute, &sizeRef) == kAXErrorSuccess && sizeRef) {
        AXValueGetValue((AXValueRef)sizeRef, kAXValueCGSizeType, &size);
        CFRelease(sizeRef);
      }
      if (CGRectIsNull(bounds)) { match = win; CFRetain(match); break; }
      CGFloat dist = fabs(pos.x - bounds.origin.x) + fabs(pos.y - bounds.origin.y) +
                     fabs(size.width - bounds.size.width) + fabs(size.height - bounds.size.height);
      if (dist < bestDist) { bestDist = dist; match = win; }
    }
    if (match) CFRetain(match);
    CFRelease(wins);
  }
  CFRelease(app);
  return match;
}

static BOOL IsAppFrontmost(pid_t pid) {
  NSRunningApplication *front = [NSWorkspace sharedWorkspace].frontmostApplication;
  return front != nil && [front processIdentifier] == pid;
}

static Napi::Value ActivateWindow(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  CGWindowID wid = ParseWindowId(info[0].As<Napi::String>().Utf8Value(), &pid);
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  BOOL activated = NO;
  if (app) activated = [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
  if (activated && wid) {
    CGRect bounds = CGRectNull;
    NSDictionary *w = WindowInfo(wid);
    if (w) {
      NSDictionary *b = w[(__bridge NSString *)kCGWindowBounds];
      if (b) {
        bounds.origin.x = [b[@"X"] doubleValue];
        bounds.origin.y = [b[@"Y"] doubleValue];
        bounds.size.width = [b[@"Width"] doubleValue];
        bounds.size.height = [b[@"Height"] doubleValue];
      }
    }
    AXUIElementRef win = FindAXWindow(pid, bounds);
    if (win) {
      AXUIElementPerformAction(win, kAXRaiseAction);
      CFRelease(win);
    }
  }
  if (activated) {
    // Verify the app actually became frontmost: keyboard input follows the
    // focused app, so a refused activation must fail here, not type elsewhere.
    for (int i = 0; i < 10 && !IsAppFrontmost(pid); i++) usleep(50 * 1000);
    activated = IsAppFrontmost(pid);
  }
  return JsBool(env, activated);
}

static Napi::Value IsFrontmost(const Napi::CallbackInfo &info) {
  pid_t pid = 0;
  ParseWindowId(info[0].As<Napi::String>().Utf8Value(), &pid);
  return JsBool(info.Env(), IsAppFrontmost(pid));
}

static void AddNode(Napi::Env env, Napi::Array &out, AXUIElementRef node, const std::string &parentId,
                    int depth, int maxDepth, int &count, std::string &checksum) {
  if (!node || depth > maxDepth || count >= 2000) return;
  CFTypeRef roleRef = NULL, nameRef = NULL, aidRef = NULL;
  AXUIElementCopyAttributeValue(node, kAXRoleAttribute, &roleRef);
  AXUIElementCopyAttributeValue(node, kAXTitleAttribute, &nameRef);
  AXUIElementCopyAttributeValue(node, kAXIdentifierAttribute, &aidRef);
  std::string role = roleRef && CFGetTypeID(roleRef) == CFStringGetTypeID() ? NSStr((__bridge NSString *)roleRef) : "";
  std::string name = nameRef && CFGetTypeID(nameRef) == CFStringGetTypeID() ? NSStr((__bridge NSString *)nameRef) : "";
  std::string elementId = "mac:ax:" + std::to_string(count);
  checksum += role + "|" + name + ";";
  Napi::Object o = Napi::Object::New(env);
  o.Set("elementId", JsString(env, elementId));
  if (!parentId.empty()) o.Set("parent", JsString(env, parentId));
  o.Set("role", JsString(env, role));
  o.Set("name", JsString(env, name));
  if (aidRef) o.Set("automationId", JsString(env, NSStr((__bridge NSString *)aidRef)));
  o.Set("enabled", JsBool(env, true));
  o.Set("visible", JsBool(env, true));
  o.Set("childCount", JsNumber(env, 0));
  out.Set(count, o);
  int myIndex = count++;
  CFArrayRef children = NULL;
  if (AXUIElementCopyAttributeValue(node, kAXChildrenAttribute, (CFTypeRef *)&children) == kAXErrorSuccess && children) {
    CFIndex n = CFArrayGetCount(children);
    for (CFIndex i = 0; i < n && count < 2000; i++) {
      AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, i);
      AddNode(env, out, child, elementId, depth + 1, maxDepth, count, checksum);
    }
    CFRelease(children);
  }
  if (roleRef) CFRelease(roleRef);
  if (nameRef) CFRelease(nameRef);
  if (aidRef) CFRelease(aidRef);
}

static Napi::Value AccessibilityTree(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  pid_t pid = 0;
  CGWindowID wid = ParseWindowId(info[0].As<Napi::String>().Utf8Value(), &pid);
  int maxDepth = info.Length() > 2 ? info[2].As<Napi::Number>().Int32Value() : 32;
  NSDictionary *w = WindowInfo(wid);
  if (!w) {
    Napi::Error::New(env, "WINDOW_NOT_FOUND").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // The CGWindow owner must match the pid encoded in the window id; a
  // mismatch means the id resolves to a different app than the caller claims.
  NSNumber *ownerPid = w[(__bridge NSString *)kCGWindowOwnerPID];
  if (ownerPid && [ownerPid intValue] != pid) {
    Napi::Error::New(env, "WINDOW_NOT_FOUND").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  CGRect bounds = CGRectNull;
  NSDictionary *b = w[(__bridge NSString *)kCGWindowBounds];
  if (b) {
    bounds.origin.x = [b[@"X"] doubleValue];
    bounds.origin.y = [b[@"Y"] doubleValue];
    bounds.size.width = [b[@"Width"] doubleValue];
    bounds.size.height = [b[@"Height"] doubleValue];
  }
  // Strictly scoped to the target window: never fall back to the whole app
  // tree (that would widen the reported UI surface beyond the window).
  AXUIElementRef root = FindAXWindow(pid, bounds);
  if (!root) {
    Napi::Error::New(env, "UIA_ROOT_UNAVAILABLE").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Array nodes = Napi::Array::New(env);
  int count = 0;
  std::string checksum;
  AddNode(env, nodes, root, "", 0, maxDepth, count, checksum);
  CFRelease(root);
  Napi::Object result = Napi::Object::New(env);
  result.Set("nodes", nodes);
  result.Set("checksum", JsString(env, checksum));
  result.Set("mode", JsString(env, "full"));
  result.Set("truncated", JsBool(env, count >= 2000));
  return result;
}

static CGPoint MakePoint(double x, double y) {
  return CGPointMake(x, y);
}

static Napi::Value MoveCursor(const Napi::CallbackInfo &info) {
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();
  CGEventRef ev = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, MakePoint(x, y), kCGMouseButtonLeft);
  if (!ev) return JsBool(info.Env(), false);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return JsBool(info.Env(), true);
}

static CGEventType ButtonEventType(bool down, int button) {
  switch (button) {
    case 1: return down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
    case 2: return down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
    default: return down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
  }
}

static CGMouseButton CGMouseButtonFor(int button) {
  return button == 1 ? kCGMouseButtonRight : button == 2 ? kCGMouseButtonCenter : kCGMouseButtonLeft;
}

static Napi::Value Click(const Napi::CallbackInfo &info) {
  std::string buttonStr = info[0].As<Napi::String>().Utf8Value();
  int count = info[1].As<Napi::Number>().Int32Value();
  int button = buttonStr == "right" ? 1 : buttonStr == "middle" ? 2 : 0;
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  CGEventRef locEvent = CGEventCreate(NULL);
  CGPoint current = CGEventGetLocation(locEvent);
  CFRelease(locEvent);
  for (int i = 0; i < count; i++) {
    CGEventRef down = CGEventCreateMouseEvent(source, ButtonEventType(true, button), current, CGMouseButtonFor(button));
    CGEventPost(kCGHIDEventTap, down);
    CFRelease(down);
    CGEventRef up = CGEventCreateMouseEvent(source, ButtonEventType(false, button), current, CGMouseButtonFor(button));
    CGEventPost(kCGHIDEventTap, up);
    CFRelease(up);
  }
  CFRelease(source);
  return JsBool(info.Env(), true);
}

static Napi::Value TypeText(const Napi::CallbackInfo &info) {
  std::string text = info[0].As<Napi::String>().Utf8Value();
  NSString *ns = [NSString stringWithUTF8String:text.c_str()];
  if (!ns) return JsBool(info.Env(), false);
  NSUInteger len = [ns length];
  // Never truncate silently: reject inputs larger than one CGEvent can carry
  // so the caller reports a failure instead of typing half the text.
  if (len > 1024) return JsBool(info.Env(), false);
  UniChar buf[1024];
  [ns getCharacters:buf range:NSMakeRange(0, len)];
  CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  CGEventRef down = CGEventCreateKeyboardEvent(source, 0, true);
  CGEventKeyboardSetUnicodeString(down, (UniCharCount)len, buf);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateKeyboardEvent(source, 0, false);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  CFRelease(source);
  return JsBool(info.Env(), true);
}

static Napi::Value PressKey(const Napi::CallbackInfo &info) {
  int keyCode = info[0].As<Napi::Number>().Int32Value();
  bool down = info[1].As<Napi::Boolean>().Value();
  CGEventRef ev = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)keyCode, down);
  if (!ev) return JsBool(info.Env(), false);
  CGEventPost(kCGHIDEventTap, ev);
  CFRelease(ev);
  return JsBool(info.Env(), true);
}

static Napi::Value Scroll(const Napi::CallbackInfo &info) {
  double x = info[0].As<Napi::Number>().DoubleValue();
  double y = info[1].As<Napi::Number>().DoubleValue();
  int dx = info[2].As<Napi::Number>().Int32Value();
  int dy = info[3].As<Napi::Number>().Int32Value();
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, MakePoint(x, y), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, move);
  CFRelease(move);
  CGEventRef scroll = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitLine, 2, dy, dx);
  CGEventPost(kCGHIDEventTap, scroll);
  CFRelease(scroll);
  return JsBool(info.Env(), true);
}

static Napi::Value Drag(const Napi::CallbackInfo &info) {
  double x1 = info[0].As<Napi::Number>().DoubleValue();
  double y1 = info[1].As<Napi::Number>().DoubleValue();
  double x2 = info[2].As<Napi::Number>().DoubleValue();
  double y2 = info[3].As<Napi::Number>().DoubleValue();
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, MakePoint(x1, y1), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);
  int steps = 20;
  for (int i = 1; i <= steps; i++) {
    double t = (double)i / steps;
    CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDragged, MakePoint(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t), kCGMouseButtonLeft);
    CGEventPost(kCGHIDEventTap, move);
    CFRelease(move);
  }
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, MakePoint(x2, y2), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return JsBool(info.Env(), true);
}

static Napi::Value ElementClick(const Napi::CallbackInfo &info) {
  return JsBool(info.Env(), false);
}

static Napi::Value ElementRect(const Napi::CallbackInfo &info) {
  return RectToJs(info.Env(), CGRectMake(0, 0, 0, 0));
}

// Full-format, keyed clipboard snapshots: each NSPasteboardItem is copied with
// ALL of its declared types (text, images, files, HTML, ...), so restoring
// never drops formats; snapshots are keyed by session owner so concurrent or
// cross-session paste flows cannot restore the wrong content.
static NSMutableDictionary<NSString *, NSArray<NSPasteboardItem *> *> *gSavedClipboard = nil;

static NSString *ClipboardKeyFor(const Napi::CallbackInfo &info) {
  if (info.Length() > 0 && info[0].IsString()) {
    return [NSString stringWithUTF8String:info[0].As<Napi::String>().Utf8Value().c_str()];
  }
  return @"default";
}

static Napi::Value SaveClipboard(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    if (!gSavedClipboard) gSavedClipboard = [NSMutableDictionary dictionary];
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSArray<NSPasteboardItem *> *items = [pb pasteboardItems];
    NSMutableArray<NSPasteboardItem *> *copies = [NSMutableArray arrayWithCapacity:items.count];
    for (NSPasteboardItem *item in items) {
      NSPasteboardItem *copy = [[NSPasteboardItem alloc] init];
      for (NSString *type in [item types]) {
        NSData *data = [item dataForType:type];
        if (data) [copy setData:data forType:type];
      }
      [copies addObject:copy];
    }
    gSavedClipboard[ClipboardKeyFor(info)] = copies;
  }
  return JsBool(info.Env(), true);
}

static Napi::Value RestoreClipboard(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSArray<NSPasteboardItem *> *items = gSavedClipboard[ClipboardKeyFor(info)];
    if (items) {
      [pb clearContents];
      [pb writeObjects:items];
      [gSavedClipboard removeObjectForKey:ClipboardKeyFor(info)];
    }
  }
  return JsBool(info.Env(), true);
}

static Napi::Value SetClipboardText(const Napi::CallbackInfo &info) {
  std::string text = info[0].As<Napi::String>().Utf8Value();
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    [pb clearContents];
    [pb setString:[NSString stringWithUTF8String:text.c_str()] forType:NSPasteboardTypeString];
  }
  return JsBool(info.Env(), true);
}

static Napi::Value GetClipboardText(const Napi::CallbackInfo &info) {
  @autoreleasepool {
    NSPasteboard *pb = [NSPasteboard generalPasteboard];
    NSString *s = [pb stringForType:NSPasteboardTypeString];
    return JsString(info.Env(), NSStr(s));
  }
}

static Napi::Value Paste(const Napi::CallbackInfo &info) {
  CGEventRef down = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)9, true);
  CGEventSetFlags(down, kCGEventFlagMaskCommand);
  CGEventPost(kCGHIDEventTap, down);
  CFRelease(down);
  CGEventRef up = CGEventCreateKeyboardEvent(NULL, (CGKeyCode)9, false);
  CGEventSetFlags(up, 0);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(up);
  return JsBool(info.Env(), true);
}

static Napi::Value OverlayCreate(const Napi::CallbackInfo &info) {
  return JsNumber(info.Env(), 1);
}

static Napi::Value OverlayShow(const Napi::CallbackInfo &info) {
  return JsBool(info.Env(), true);
}

static Napi::Value OverlayHide(const Napi::CallbackInfo &info) {
  return JsBool(info.Env(), true);
}

static Napi::Value OverlayDestroy(const Napi::CallbackInfo &info) {
  return JsBool(info.Env(), true);
}

static Napi::Value RestoreSystemCursors(const Napi::CallbackInfo &info) {
  return JsBool(info.Env(), true);
}

static Napi::Value RuntimeInfo(const Napi::CallbackInfo &info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
  o.Set("platform", JsString(env, "darwin"));
#if defined(__arm64__) || defined(__aarch64__)
  o.Set("arch", JsString(env, "arm64"));
#elif defined(__x86_64__) || defined(__amd64__)
  o.Set("arch", JsString(env, "x64"));
#else
  o.Set("arch", JsString(env, "unknown"));
#endif
  o.Set("node", JsString(env, NODE_VERSION));
  o.Set("napi", env.Undefined());
  return o;
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("runtimeInfo", Napi::Function::New(env, RuntimeInfo));
  exports.Set("listWindows", Napi::Function::New(env, ListWindows));
  exports.Set("getWindow", Napi::Function::New(env, GetWindow));
  exports.Set("captureWindow", Napi::Function::New(env, CaptureWindow));
  exports.Set("activateWindow", Napi::Function::New(env, ActivateWindow));
  exports.Set("isFrontmost", Napi::Function::New(env, IsFrontmost));
  exports.Set("accessibilityTree", Napi::Function::New(env, AccessibilityTree));
  exports.Set("moveCursor", Napi::Function::New(env, MoveCursor));
  exports.Set("click", Napi::Function::New(env, Click));
  exports.Set("typeText", Napi::Function::New(env, TypeText));
  exports.Set("pressKey", Napi::Function::New(env, PressKey));
  exports.Set("scroll", Napi::Function::New(env, Scroll));
  exports.Set("drag", Napi::Function::New(env, Drag));
  exports.Set("elementClick", Napi::Function::New(env, ElementClick));
  exports.Set("elementRect", Napi::Function::New(env, ElementRect));
  exports.Set("saveClipboard", Napi::Function::New(env, SaveClipboard));
  exports.Set("restoreClipboard", Napi::Function::New(env, RestoreClipboard));
  exports.Set("setClipboardText", Napi::Function::New(env, SetClipboardText));
  exports.Set("getClipboardText", Napi::Function::New(env, GetClipboardText));
  exports.Set("paste", Napi::Function::New(env, Paste));
  exports.Set("overlayCreate", Napi::Function::New(env, OverlayCreate));
  exports.Set("overlayShow", Napi::Function::New(env, OverlayShow));
  exports.Set("overlayHide", Napi::Function::New(env, OverlayHide));
  exports.Set("overlayDestroy", Napi::Function::New(env, OverlayDestroy));
  exports.Set("restoreSystemCursors", Napi::Function::New(env, RestoreSystemCursors));
  return exports;
}

NODE_API_MODULE(dsh_computer_use_macos_native, Init)
