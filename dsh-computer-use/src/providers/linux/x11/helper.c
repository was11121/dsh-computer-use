/*
 * dsh-computer-use X11 helper.
 *
 * A small native helper process that owns the X11 connection and exposes
 * JSON-lines over stdio. The Node provider spawns this binary and sends
 * requests such as:
 *
 *   {"id":1,"method":"listWindows"}
 *   {"id":2,"method":"getWindow","windowId":"x11:xid:0x03400007"}
 *
 * Protocol contract: every response echoes the request id
 * ({"id":1,"ok":true,...}). The provider matches responses strictly by id
 * and drops anything else, so an id-less response is never delivered.
 *
 * Build (on Linux):
 *   cc -O2 -o dsh-computer-use-x11-helper helper.c -lX11 -lXtst -lXext -lz
 */

#define _XOPEN_SOURCE 700

#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <X11/Xutil.h>
#include <X11/extensions/XTest.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <zlib.h>

static Display *dpy = NULL;

/* ------------------------------------------------------------------ */
/* Small JSON output helpers (no external json lib).                   */
/* ------------------------------------------------------------------ */

static void json_escape(FILE *out, const char *s) {
  fputc('"', out);
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    switch (*p) {
      case '"': fputs("\\\"", out); break;
      case '\\': fputs("\\\\", out); break;
      case '\n': fputs("\\n", out); break;
      case '\r': fputs("\\r", out); break;
      case '\t': fputs("\\t", out); break;
      default:
        if (*p < 0x20) fprintf(out, "\\u%04x", *p);
        else fputc(*p, out);
    }
  }
  fputc('"', out);
}

static void json_rect(FILE *out, int x, int y, int w, int h) {
  fprintf(out, "{\"left\":%d,\"top\":%d,\"right\":%d,\"bottom\":%d,\"width\":%d,\"height\":%d}",
          x, y, x + w, y + h, w, h);
}

static void window_id_to_string(char *buf, size_t len, Window w) {
  snprintf(buf, len, "x11:xid:0x%08lx", (unsigned long)w);
}

static int parse_window_id(const char *id, Window *out) {
  if (strncmp(id, "x11:xid:0x", 10) != 0) return 0;
  char *end = NULL;
  unsigned long v = strtoul(id + 10, &end, 16);
  if (!end || *end != '\0') return 0;
  *out = (Window)v;
  return 1;
}

/* ------------------------------------------------------------------ */
/* Window property helpers                                             */
/* ------------------------------------------------------------------ */

static char *get_utf8_prop(Window w, Atom prop) {
  Atom type = None;
  int format = 0;
  unsigned long nitems = 0, bytes_after = 0;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy, w, prop, 0, 1024, False, XA_STRING,
                         &type, &format, &nitems, &bytes_after, &data) != Success || !data) {
    return NULL;
  }
  char *result = strndup((char *)data, nitems);
  XFree(data);
  return result;
}

static char *get_net_wm_name(Window w) {
  Atom utf8 = XInternAtom(dpy, "UTF8_STRING", False);
  Atom type = None;
  int format = 0;
  unsigned long nitems = 0, bytes_after = 0;
  unsigned char *data = NULL;
  if (XGetWindowProperty(dpy, w, XInternAtom(dpy, "_NET_WM_NAME", False), 0, 1024,
                         False, utf8, &type, &format, &nitems, &bytes_after, &data) == Success && data) {
    char *result = strndup((char *)data, nitems);
    XFree(data);
    return result;
  }
  return get_utf8_prop(w, XA_WM_NAME);
}

static pid_t get_window_pid(Window w) {
  Atom pid_atom = XInternAtom(dpy, "_NET_WM_PID", False);
  Atom type = None;
  int format = 0;
  unsigned long nitems = 0, bytes_after = 0;
  unsigned char *data = NULL;
  pid_t pid = 0;
  if (XGetWindowProperty(dpy, w, pid_atom, 0, 1, False, XA_CARDINAL,
                         &type, &format, &nitems, &bytes_after, &data) == Success && data && nitems > 0) {
    pid = (pid_t)(*((unsigned long *)data));
    XFree(data);
  }
  return pid;
}

static int emit_window_json(FILE *out, Window w, int *first) {
  char id[64];
  window_id_to_string(id, sizeof(id), w);
  char *title = get_net_wm_name(w);
  char *cls_res = get_utf8_prop(w, XA_WM_CLASS);
  pid_t pid = get_window_pid(w);
  XWindowAttributes attrs;
  // Never read a possibly-uninitialized XWindowAttributes: fail the window
  // entry when the query fails instead of emitting garbage coordinates.
  if (!XGetWindowAttributes(dpy, w, &attrs)) {
    free(title);
    free(cls_res);
    return 0;
  }
  // attrs.x/attrs.y are relative to the (possibly reparented) parent. Translate
  // to root coordinates so window-relative screenshot math is correct under
  // reparenting window managers.
  int x = attrs.x, y = attrs.y;
  Window child = None;
  if (XTranslateCoordinates(dpy, w, DefaultRootWindow(dpy), 0, 0, &x, &y, &child) == False) {
    free(title);
    free(cls_res);
    return 0;
  }
  if (*first) *first = 0;
  else fputc(',', out);
  fprintf(out, "{\"windowId\":\"%s\",\"title\":", id);
  json_escape(out, title ? title : "");
  fprintf(out, ",\"appName\":\"\",\"processId\":%ld,\"processPath\":\"\",\"className\":", (long)pid);
  json_escape(out, cls_res ? cls_res : "");
  fprintf(out, ",\"rect\":");
  json_rect(out, x, y, attrs.width, attrs.height);
  fprintf(out, ",\"visible\":%s,\"minimized\":%s,\"onScreen\":%s,\"foreground\":%s,\"dpi\":96}",
          attrs.map_state == IsViewable ? "true" : "false",
          attrs.map_state == IsUnmapped ? "true" : "false",
          "true", "false");
  free(title);
  free(cls_res);
  return 1;
}

/* ------------------------------------------------------------------ */
/* Methods                                                             */
/* ------------------------------------------------------------------ */

static void method_list_windows(FILE *out) {
  Atom net_cl = XInternAtom(dpy, "_NET_CLIENT_LIST", False);
  Atom type = None;
  int format = 0;
  unsigned long nitems = 0, bytes_after = 0;
  unsigned char *data = NULL;
  Window root = DefaultRootWindow(dpy);
  fputs("{\"ok\":true,\"value\":[", out);
  if (XGetWindowProperty(dpy, root, net_cl, 0, 4096, False, XA_WINDOW,
                         &type, &format, &nitems, &bytes_after, &data) == Success && data) {
    Window *windows = (Window *)data;
    int first = 1;
    for (unsigned long i = 0; i < nitems; i++) {
      // Windows that cannot be queried (gone / unmapped under the WM) are
      // skipped rather than emitted with garbage geometry.
      emit_window_json(out, windows[i], &first);
    }
    XFree(data);
  }
  fputs("]}\n", out);
}

static void method_get_window(FILE *out, const char *wid) {
  Window w = 0;
  if (!parse_window_id(wid, &w)) {
    fputs("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"invalid window id\",\"recovery\":\"REQUIRES_REFRESH\"}\n", out);
    return;
  }
  char *buf = NULL;
  size_t buflen = 0;
  FILE *tmp = open_memstream(&buf, &buflen);
  if (!tmp) {
    fputs("{\"ok\":false,\"code\":\"HELPER_ERROR\",\"message\":\"out of memory\",\"recovery\":\"RETRY\"}\n", out);
    return;
  }
  int first = 1;
  if (!emit_window_json(tmp, w, &first)) {
    fclose(tmp);
    free(buf);
    fputs("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"window is gone or not queryable\",\"recovery\":\"REQUIRES_REFRESH\"}\n", out);
    return;
  }
  fclose(tmp);
  fprintf(out, "{\"ok\":true,\"value\":%s}\n", buf);
  free(buf);
}

/* Minimal PNG writer using zlib (filter 0, truecolor). */
static int write_png(const char *path, int width, int height, const unsigned char *rgb) {
  FILE *fp = fopen(path, "wb");
  if (!fp) return 0;
  static const unsigned char sig[8] = {137, 80, 78, 71, 13, 10, 26, 10};
  fwrite(sig, 1, 8, fp);

  unsigned char ihdr[13] = {0};
  ihdr[0] = (width >> 24) & 0xff; ihdr[1] = (width >> 16) & 0xff;
  ihdr[2] = (width >> 8) & 0xff;  ihdr[3] = width & 0xff;
  ihdr[4] = (height >> 24) & 0xff; ihdr[5] = (height >> 16) & 0xff;
  ihdr[6] = (height >> 8) & 0xff;  ihdr[7] = height & 0xff;
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  unsigned char len[4] = {0, 0, 0, 13};
  fwrite(len, 1, 4, fp);
  fwrite("IHDR", 1, 4, fp);
  fwrite(ihdr, 1, 13, fp);
  unsigned long crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, (const Bytef *)"IHDR", 4);
  crc = crc32(crc, ihdr, 13);
  unsigned char crcb[4];
  crcb[0] = (crc >> 24) & 0xff; crcb[1] = (crc >> 16) & 0xff;
  crcb[2] = (crc >> 8) & 0xff; crcb[3] = crc & 0xff;
  fwrite(crcb, 1, 4, fp);

  size_t raw_len = (size_t)height * (1 + (size_t)width * 3);
  unsigned char *raw = (unsigned char *)malloc(raw_len);
  unsigned char *comp = (unsigned char *)malloc(compressBound(raw_len));
  if (!raw || !comp) {
    free(raw);
    free(comp);
    fclose(fp);
    return 0;
  }
  for (int y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0;
    memcpy(raw + y * (1 + width * 3) + 1, rgb + (size_t)y * width * 3, (size_t)width * 3);
  }
  uLongf comp_len = compressBound(raw_len);
  if (compress2(comp, &comp_len, raw, raw_len, 6) != Z_OK) {
    free(raw);
    free(comp);
    fclose(fp);
    return 0;
  }
  unsigned char clen[4];
  clen[0] = (comp_len >> 24) & 0xff; clen[1] = (comp_len >> 16) & 0xff;
  clen[2] = (comp_len >> 8) & 0xff; clen[3] = comp_len & 0xff;
  fwrite(clen, 1, 4, fp);
  fwrite("IDAT", 1, 4, fp);
  fwrite(comp, 1, comp_len, fp);
  crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, (const Bytef *)"IDAT", 4);
  crc = crc32(crc, comp, comp_len);
  crcb[0] = (crc >> 24) & 0xff; crcb[1] = (crc >> 16) & 0xff;
  crcb[2] = (crc >> 8) & 0xff; crcb[3] = crc & 0xff;
  fwrite(crcb, 1, 4, fp);

  unsigned char iend[4] = {0, 0, 0, 0};
  fwrite(iend, 1, 4, fp);
  fwrite("IEND", 1, 4, fp);
  crc = crc32(0L, Z_NULL, 0);
  crc = crc32(crc, (const Bytef *)"IEND", 4);
  crcb[0] = (crc >> 24) & 0xff; crcb[1] = (crc >> 16) & 0xff;
  crcb[2] = (crc >> 8) & 0xff; crcb[3] = crc & 0xff;
  fwrite(crcb, 1, 4, fp);

  free(raw);
  free(comp);
  fclose(fp);
  return 1;
}

static void method_capture_window(FILE *out, const char *wid, const char *path) {
  Window w = 0;
  if (!parse_window_id(wid, &w)) {
    fputs("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"invalid window id\",\"recovery\":\"REQUIRES_REFRESH\"}\n", out);
    return;
  }
  XWindowAttributes attrs;
  if (!XGetWindowAttributes(dpy, w, &attrs) || attrs.width <= 0 || attrs.height <= 0) {
    fputs("{\"ok\":false,\"code\":\"NATIVE_CAPTURE_FAILED\",\"message\":\"window has no geometry\",\"recovery\":\"RETRY\"}\n", out);
    return;
  }
  XImage *img = XGetImage(dpy, w, 0, 0, attrs.width, attrs.height, AllPlanes, ZPixmap);
  if (!img) {
    fputs("{\"ok\":false,\"code\":\"NATIVE_CAPTURE_FAILED\",\"message\":\"XGetImage failed\",\"recovery\":\"RETRY\"}\n", out);
    return;
  }
  unsigned char *rgb = (unsigned char *)malloc((size_t)attrs.width * attrs.height * 3);
  if (!rgb) {
    XDestroyImage(img);
    fputs("{\"ok\":false,\"code\":\"NATIVE_CAPTURE_FAILED\",\"message\":\"out of memory\",\"recovery\":\"RETRY\"}\n", out);
    return;
  }
  for (int y = 0; y < attrs.height; y++) {
    for (int x = 0; x < attrs.width; x++) {
      unsigned long px = XGetPixel(img, x, y);
      size_t off = ((size_t)y * attrs.width + x) * 3;
      rgb[off] = (px >> 16) & 0xff;
      rgb[off + 1] = (px >> 8) & 0xff;
      rgb[off + 2] = px & 0xff;
    }
  }
  int ok = write_png(path, attrs.width, attrs.height, rgb);
  free(rgb);
  XDestroyImage(img);
  if (!ok) {
    fputs("{\"ok\":false,\"code\":\"NATIVE_CAPTURE_FAILED\",\"message\":\"PNG write failed\",\"recovery\":\"RETRY\"}\n", out);
    return;
  }
  fprintf(out, "{\"ok\":true,\"value\":{\"path\":");
  json_escape(out, path);
  fprintf(out, ",\"rect\":");
  json_rect(out, attrs.x, attrs.y, attrs.width, attrs.height);
  fputs("}}\n", out);
}

static void method_activate_window(FILE *out, const char *wid) {
  Window w = 0;
  if (!parse_window_id(wid, &w)) {
    fputs("{\"ok\":false,\"code\":\"WINDOW_NOT_FOUND\",\"message\":\"invalid window id\",\"recovery\":\"REQUIRES_REFRESH\"}\n", out);
    return;
  }
  Atom active = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
  XEvent ev;
  memset(&ev, 0, sizeof(ev));
  ev.xclient.type = ClientMessage;
  ev.xclient.window = w;
  ev.xclient.message_type = active;
  ev.xclient.format = 32;
  ev.xclient.data.l[0] = 2; /* source indication: pager */
  ev.xclient.data.l[1] = CurrentTime;
  ev.xclient.data.l[2] = 0;
  XSendEvent(dpy, DefaultRootWindow(dpy), False, SubstructureRedirectMask | SubstructureNotifyMask, &ev);
  XFlush(dpy);
  /* The ClientMessage is only a request: the WM may refuse it (focus-stealing
   * prevention, other workspace) or there may be no WM at all. Poll the
   * root's _NET_ACTIVE_WINDOW and report success only when the target really
   * became active — the Node provider injects global XTest input and must
   * never type into whatever else holds focus. */
  int verified = 0;
  for (int i = 0; i < 20 && !verified; i++) {
    if (i) usleep(25 * 1000);
    Atom type = None;
    int format = 0;
    unsigned long nitems = 0, bytes_after = 0;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, DefaultRootWindow(dpy), active, 0, 1, False, XA_WINDOW,
                           &type, &format, &nitems, &bytes_after, &data) == Success && data && nitems > 0) {
      if (*((Window *)data) == w) verified = 1;
      XFree(data);
    }
  }
  fprintf(out, "{\"ok\":true,\"value\":%s}\n", verified ? "true" : "false");
}

/* ------------------------------------------------------------------ */
/* Input via XTest                                                     */
/* ------------------------------------------------------------------ */

static void method_move_cursor(FILE *out, const char *xstr, const char *ystr) {
  int x = atoi(xstr), y = atoi(ystr);
  XTestFakeMotionEvent(dpy, -1, x, y, CurrentTime);
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

static void method_click(FILE *out, const char *xstr, const char *ystr, const char *button, const char *countstr) {
  int x = atoi(xstr ? xstr : "0");
  int y = atoi(ystr ? ystr : "0");
  int count = atoi(countstr ? countstr : "1");
  if (count < 1) count = 1;
  if (count > 3) count = 3;
  int btn = strcmp(button, "right") == 0 ? 3 : strcmp(button, "middle") == 0 ? 2 : 1;
  XTestFakeMotionEvent(dpy, -1, x, y, CurrentTime);
  for (int i = 0; i < count; i++) {
    XTestFakeButtonEvent(dpy, btn, True, CurrentTime);
    XTestFakeButtonEvent(dpy, btn, False, CurrentTime);
  }
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

static KeySym keysym_for_char(char c) {
  if (c >= 'a' && c <= 'z') return XK_a + (c - 'a');
  if (c >= 'A' && c <= 'Z') return XK_A + (c - 'A');
  if (c >= '0' && c <= '9') return XK_0 + (c - '0');
  switch (c) {
    case ' ': return XK_space;
    case '!': return XK_exclam;
    case '"': return XK_quotedbl;
    case '#': return XK_numbersign;
    case '$': return XK_dollar;
    case '%': return XK_percent;
    case '&': return XK_ampersand;
    case '\'': return XK_apostrophe;
    case '(': return XK_parenleft;
    case ')': return XK_parenright;
    case '*': return XK_asterisk;
    case '+': return XK_plus;
    case ',': return XK_comma;
    case '-': return XK_minus;
    case '.': return XK_period;
    case '/': return XK_slash;
    case ':': return XK_colon;
    case ';': return XK_semicolon;
    case '<': return XK_less;
    case '=': return XK_equal;
    case '>': return XK_greater;
    case '?': return XK_question;
    case '@': return XK_at;
    case '[': return XK_bracketleft;
    case '\\': return XK_backslash;
    case ']': return XK_bracketright;
    case '^': return XK_asciicircum;
    case '_': return XK_underscore;
    case '`': return XK_grave;
    case '{': return XK_braceleft;
    case '|': return XK_bar;
    case '}': return XK_braceright;
    case '~': return XK_asciitilde;
    default: return NoSymbol;
  }
}

static void method_type_text(FILE *out, const char *text) {
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p >= 0x80) {
      fputs("{\"ok\":false,\"code\":\"UNSUPPORTED_TEXT\",\"message\":\"non-ASCII text requires clipboard paste which is not implemented\",\"recovery\":\"RETRY\"}\n", out);
      return;
    }
  }
  for (const char *p = text; *p; p++) {
    KeySym ks = keysym_for_char(*p);
    // Never drop characters silently: an unmapped character fails the input
    // so the caller sees partial input instead of assuming full delivery.
    if (ks == NoSymbol) {
      fprintf(out, "{\"ok\":false,\"code\":\"UNSUPPORTED_TEXT\",\"message\":\"unmapped character: '%c'\",\"recovery\":\"RETRY\"}\n", *p);
      return;
    }
    KeyCode kc = XKeysymToKeycode(dpy, ks);
    if (!kc) {
      fprintf(out, "{\"ok\":false,\"code\":\"UNSUPPORTED_TEXT\",\"message\":\"no keycode for: '%c'\",\"recovery\":\"RETRY\"}\n", *p);
      return;
    }
    XTestFakeKeyEvent(dpy, kc, True, CurrentTime);
    XTestFakeKeyEvent(dpy, kc, False, CurrentTime);
  }
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

/* Every spelling that resolves to the OS-level Super/Meta/Hyper modifier
 * layer. Blocked before XStringToKeysym so neither aliases ("cmd") nor raw
 * keysym names ("Super_L", "Meta_R", "Hyper_L") can reach XTest. */
static const char *BLOCKED_META_NAMES[] = {
  "super", "cmd", "command", "meta", "win", "windows", "os",
  "super_l", "super_r", "meta_l", "meta_r",
  "hyper", "hyper_l", "hyper_r",
  "leftmeta", "rightmeta", "leftsuper", "rightsuper",
  "lwin", "rwin", "leftwindows", "rightwindows",
};

static int is_meta_name(const char *name) {
  char lower[32];
  size_t i = 0;
  for (; name[i] && i + 1 < sizeof(lower); i++) {
    char c = name[i];
    lower[i] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
  }
  lower[i] = '\0';
  for (size_t k = 0; k < sizeof(BLOCKED_META_NAMES) / sizeof(BLOCKED_META_NAMES[0]); k++) {
    if (strcmp(lower, BLOCKED_META_NAMES[k]) == 0) return 1;
  }
  return 0;
}

static KeyCode keycode_for_name(const char *name) {
  if (!name || !*name) return 0;
  /* Numeric keycodes are deliberately NOT accepted: a raw keycode would
   * inject arbitrary physical keys (whatever Super/Meta map to on this
   * layout) regardless of every name-based blocklist. Callers send
   * symbolic names only. */
  if (is_meta_name(name)) return 0;
  const char *alias = NULL;
  if (strcmp(name, "ctrl") == 0 || strcmp(name, "control") == 0) alias = "Control_L";
  else if (strcmp(name, "shift") == 0) alias = "Shift_L";
  else if (strcmp(name, "alt") == 0 || strcmp(name, "option") == 0) alias = "Alt_L";
  KeySym ks = XStringToKeysym(alias ? alias : name);
  if (ks == NoSymbol) return 0;
  return XKeysymToKeycode(dpy, ks);
}

static void method_press_key(FILE *out, const char *key) {
  char buf[256];
  snprintf(buf, sizeof(buf), "%s", key ? key : "");
  KeyCode codes[8];
  int n = 0;
  char *save = NULL;
  char *tok = strtok_r(buf, "+", &save);
  while (tok && n < 8) {
    while (*tok == ' ') tok++;
    char *end = tok + strlen(tok);
    while (end > tok && end[-1] == ' ') *--end = '\0';
    KeyCode kc = keycode_for_name(tok);
    if (!kc) {
      fprintf(out, "{\"ok\":false,\"code\":\"UNSUPPORTED_KEY\",\"message\":\"unsupported key: %s\",\"recovery\":\"DENY\"}\n", tok);
      return;
    }
    codes[n++] = kc;
    tok = strtok_r(NULL, "+", &save);
  }
  if (n == 0) {
    fputs("{\"ok\":false,\"code\":\"UNSUPPORTED_KEY\",\"message\":\"empty key\",\"recovery\":\"DENY\"}\n", out);
    return;
  }
  for (int i = 0; i < n; i++) XTestFakeKeyEvent(dpy, codes[i], True, CurrentTime);
  for (int i = n - 1; i >= 0; i--) XTestFakeKeyEvent(dpy, codes[i], False, CurrentTime);
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

static void method_scroll(FILE *out, const char *xstr, const char *ystr, const char *dxstr, const char *dystr) {
  int x = atoi(xstr), y = atoi(ystr);
  int dx = atoi(dxstr), dy = atoi(dystr);
  XTestFakeMotionEvent(dpy, -1, x, y, CurrentTime);
  if (dy > 0) XTestFakeButtonEvent(dpy, 4, True, CurrentTime), XTestFakeButtonEvent(dpy, 4, False, CurrentTime);
  else if (dy < 0) XTestFakeButtonEvent(dpy, 5, True, CurrentTime), XTestFakeButtonEvent(dpy, 5, False, CurrentTime);
  if (dx > 0) XTestFakeButtonEvent(dpy, 7, True, CurrentTime), XTestFakeButtonEvent(dpy, 7, False, CurrentTime);
  else if (dx < 0) XTestFakeButtonEvent(dpy, 6, True, CurrentTime), XTestFakeButtonEvent(dpy, 6, False, CurrentTime);
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

static void method_drag(FILE *out, const char *x1, const char *y1, const char *x2, const char *y2) {
  int ax = atoi(x1), ay = atoi(y1), bx = atoi(x2), by = atoi(y2);
  XTestFakeMotionEvent(dpy, -1, ax, ay, CurrentTime);
  XTestFakeButtonEvent(dpy, 1, True, CurrentTime);
  int steps = 20;
  for (int i = 1; i <= steps; i++) {
    int cx = ax + (bx - ax) * i / steps;
    int cy = ay + (by - ay) * i / steps;
    XTestFakeMotionEvent(dpy, -1, cx, cy, CurrentTime);
  }
  XTestFakeButtonEvent(dpy, 1, False, CurrentTime);
  XFlush(dpy);
  fputs("{\"ok\":true,\"value\":true}\n", out);
}

/* ------------------------------------------------------------------ */
/* Accessibility (AT-SPI2 via D-Bus) — draft stub                       */
/* ------------------------------------------------------------------ */

static void method_accessibility_tree(FILE *out) {
  /* Full AT-SPI2 D-Bus client is TODO. Return an empty tree so the protocol
   * shape is stable; providers should report accessibilityTree:false when the
   * app does not expose AT-SPI. */
  fputs("{\"ok\":true,\"value\":{\"nodes\":[],\"checksum\":\"\",\"mode\":\"platform\",\"truncated\":false}}\n", out);
}

/* ------------------------------------------------------------------ */
/* Clipboard (X11 selection) — draft stub                               */
/* ------------------------------------------------------------------ */

static void method_save_clipboard(FILE *out) {
  /* TODO: XConvertSelection + serialize targets. */
  fputs("{\"ok\":true,\"value\":false}\n", out);
}

static void method_restore_clipboard(FILE *out) {
  fputs("{\"ok\":true,\"value\":false}\n", out);
}

/* ------------------------------------------------------------------ */
/* Main loop                                                           */
/* ------------------------------------------------------------------ */

#define MAX_LINE_LEN (1024 * 1024)
static char *read_line(FILE *in) {
  size_t cap = 1024, len = 0;
  char *buf = (char *)malloc(cap);
  if (!buf) return NULL;
  int c;
  while ((c = fgetc(in)) != EOF && c != '\n') {
    if (len + 1 >= cap) {
      if (cap >= MAX_LINE_LEN) { free(buf); return NULL; }
      cap *= 2;
      if (cap > MAX_LINE_LEN) cap = MAX_LINE_LEN;
      char *nb = (char *)realloc(buf, cap);
      if (!nb) { free(buf); return NULL; }
      buf = nb;
    }
    buf[len++] = (char)c;
  }
  if (len == 0 && c == EOF) { free(buf); return NULL; }
  buf[len] = '\0';
  return buf;
}

static const char *json_field(const char *line, const char *name, char *value, size_t cap) {
  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", name);
  const char *p = strstr(line, pattern);
  if (!p) return NULL;
  p += strlen(pattern);
  while (*p == ' ' || *p == '\t') p++;
  if (*p != ':') return NULL;
  p++;
  while (*p == ' ' || *p == '\t') p++;
  size_t i = 0;
  if (*p == '"') {
    p++;
    // String field: decode JSON escapes. Buffer overflow or an unterminated
    // string FAILS the parse (NULL) instead of silently truncating.
    while (*p && i + 1 < cap) {
      if (*p == '"') { value[i] = '\0'; return value; }
      if (*p == '\\' && p[1]) {
        p++;
        switch (*p) {
          case 'n': value[i++] = '\n'; break;
          case 'r': value[i++] = '\r'; break;
          case 't': value[i++] = '\t'; break;
          case 'u': {
            if (p[1] && p[2] && p[3] && p[4]) {
              unsigned int cp = 0;
              int hex_ok = 1;
              for (int k = 1; k <= 4; k++) {
                char c = p[k];
                cp <<= 4;
                if (c >= '0' && c <= '9') cp |= (unsigned)(c - '0');
                else if (c >= 'a' && c <= 'f') cp |= (unsigned)(c - 'a' + 10);
                else if (c >= 'A' && c <= 'F') cp |= (unsigned)(c - 'A' + 10);
                else { hex_ok = 0; break; }
              }
              if (hex_ok && cp) {
                if (cp < 0x80) value[i++] = (char)cp;
                else if (cp < 0x800) {
                  value[i++] = (char)(0xC0 | (cp >> 6));
                  value[i++] = (char)(0x80 | (cp & 0x3F));
                } else {
                  value[i++] = (char)(0xE0 | (cp >> 12));
                  value[i++] = (char)(0x80 | ((cp >> 6) & 0x3F));
                  value[i++] = (char)(0x80 | (cp & 0x3F));
                }
              }
              p += 4;
            }
            break;
          }
          default: value[i++] = *p; break; /* \\ \" \/ and any other escape */
        }
        p++;
        continue;
      }
      value[i++] = *p++;
    }
    return NULL; /* unterminated or exceeds cap: fail closed, no truncation */
  }
  while (*p && *p != ',' && *p != '}' && *p != '\n' && *p != ' ' && i + 1 < cap) value[i++] = *p++;
  if (*p != ',' && *p != '}' && *p != '\n' && *p != '\0' && *p != ' ') return NULL; /* overflow */
  value[i] = '\0';
  return value[0] ? value : NULL;
}

int main(void) {
  dpy = XOpenDisplay(NULL);
  if (!dpy) {
    fprintf(stderr, "X11_CONNECTION_FAILED\n");
    return 1;
  }
  setbuf(stdout, NULL);
  char *line;
  while ((line = read_line(stdin)) != NULL) {
    char idbuf[64] = "";
    char method[64] = "";
    char wid[256] = "";
    char path[1024] = "";
    char x[64] = "";
    char y[64] = "";
    char button[64] = "";
    char count[64] = "";
    char scrollX[64] = "";
    char scrollY[64] = "";
    char fromX[64] = "";
    char fromY[64] = "";
    char toX[64] = "";
    char toY[64] = "";
    /* Matches the Node runtime's 20 000-char input cap with headroom. */
    char text[21000] = "";
    char key[256] = "";

    json_field(line, "id", idbuf, sizeof(idbuf));
    json_field(line, "method", method, sizeof(method));
    if (!method[0]) { free(line); continue; }
    json_field(line, "windowId", wid, sizeof(wid));
    json_field(line, "path", path, sizeof(path));
    json_field(line, "x", x, sizeof(x));
    json_field(line, "y", y, sizeof(y));
    json_field(line, "button", button, sizeof(button));
    json_field(line, "count", count, sizeof(count));
    json_field(line, "scrollX", scrollX, sizeof(scrollX));
    json_field(line, "scrollY", scrollY, sizeof(scrollY));
    json_field(line, "fromX", fromX, sizeof(fromX));
    json_field(line, "fromY", fromY, sizeof(fromY));
    json_field(line, "toX", toX, sizeof(toX));
    json_field(line, "toY", toY, sizeof(toY));
    json_field(line, "text", text, sizeof(text));
    json_field(line, "key", key, sizeof(key));

    /* Buffer the response so the request id can be prepended in one place.
     * The Node provider matches responses strictly by id (concurrent requests
     * must never receive each other's results); an id-less response is
     * dropped there, so the echo is part of the protocol contract. */
    char *body = NULL;
    size_t bodylen = 0;
    FILE *resp = open_memstream(&body, &bodylen);
    if (!resp) {
      fputs("{\"ok\":false,\"code\":\"HELPER_ERROR\",\"message\":\"out of memory\",\"recovery\":\"RETRY\"}\n", stdout);
      free(line);
      continue;
    }

    if (strcmp(method, "listWindows") == 0) {
      method_list_windows(resp);
    } else if (strcmp(method, "getWindow") == 0 && wid[0]) {
      method_get_window(resp, wid);
    } else if (strcmp(method, "captureWindow") == 0 && wid[0] && path[0]) {
      method_capture_window(resp, wid, path);
    } else if (strcmp(method, "activateWindow") == 0 && wid[0]) {
      method_activate_window(resp, wid);
    } else if (strcmp(method, "moveCursor") == 0 && x[0] && y[0]) {
      method_move_cursor(resp, x, y);
    } else if (strcmp(method, "click") == 0 && button[0] && count[0]) {
      method_click(resp, x, y, button, count);
    } else if (strcmp(method, "typeText") == 0 && text[0]) {
      method_type_text(resp, text);
    } else if (strcmp(method, "pressKey") == 0) {
      method_press_key(resp, key);
    } else if (strcmp(method, "scroll") == 0) {
      method_scroll(resp, x[0] ? x : "0", y[0] ? y : "0", scrollX[0] ? scrollX : "0", scrollY[0] ? scrollY : "0");
    } else if (strcmp(method, "drag") == 0) {
      method_drag(resp, fromX[0] ? fromX : "0", fromY[0] ? fromY : "0", toX[0] ? toX : "0", toY[0] ? toY : "0");
    } else if (strcmp(method, "accessibilityTree") == 0) {
      method_accessibility_tree(resp);
    } else if (strcmp(method, "saveClipboard") == 0) {
      method_save_clipboard(resp);
    } else if (strcmp(method, "restoreClipboard") == 0) {
      method_restore_clipboard(resp);
    } else {
      fprintf(resp, "{\"ok\":false,\"code\":\"UNKNOWN_METHOD\",\"message\":\"%s\",\"recovery\":\"NONE\"}\n", method);
    }
    fclose(resp);

    if (idbuf[0] && body[0] == '{') {
      /* Skip the method's opening brace and splice the id in front. The
       * method body already ends with '\n'. */
      fprintf(stdout, "{\"id\":%s,%s", idbuf, body + 1);
    } else if (body[0]) {
      fputs(body, stdout);
    }
    free(body);
    free(line);
  }
  XCloseDisplay(dpy);
  return 0;
}
