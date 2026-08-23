/**
 * One copy path for every surface that hands the reader a command.
 *
 * WHY THIS IS SHARED RATHER THAN INLINE. The start command appears in three places — the tab's
 * down state, the panel's "cannot read Rill", and the panel's "not in this snapshot yet" — and
 * each of those is a moment where the reader is already mildly stuck. A copy that silently does
 * nothing there reads as a second failure of the same surface, so the failure has to be visible
 * and the behaviour identical in all three.
 *
 * `navigator.clipboard` is present on localhost (a secure context) but not on a plain-http
 * origin, which is exactly how this plugin would be loaded from another machine on the LAN. The
 * execCommand fallback is deprecated and still the only thing that works there.
 */

export function copyTextToClipboard(host, text, label) {
  var what = label || "Command";
  var toast = (host && host.toast) || null;

  function ok() {
    if (toast && toast.success) toast.success(what + " copied");
  }
  // A failed copy must say so. Silence is indistinguishable from a copy that worked, and the
  // reader finds out only when they paste the wrong thing into a shell.
  function fail() {
    if (toast && toast.error) toast.error("Could not copy — select the text and copy manually");
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(ok, function () {
      if (!legacyCopy(text)) fail();
      else ok();
    });
    return;
  }
  if (legacyCopy(text)) ok();
  else fail();
}

/** Deprecated, and the only path available off a secure origin. */
function legacyCopy(text) {
  try {
    var area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: `display:none` and `visibility:hidden` are not selectable,
    // so the copy silently yields an empty clipboard.
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.setAttribute("readonly", "readonly");
    document.body.appendChild(area);
    area.select();
    var copied = document.execCommand("copy");
    document.body.removeChild(area);
    return copied;
  } catch (err) {
    return false;
  }
}
