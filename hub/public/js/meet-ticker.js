/* Frame clock for meeting background effects. Timers in a worker keep running when the tab is in
   the background, where requestAnimationFrame would pause and freeze the outgoing video. */
var timer = null;
self.onmessage = function (e) {
  clearInterval(timer);
  if (e.data && e.data.fps) timer = setInterval(function () { self.postMessage(0); }, 1000 / e.data.fps);
};
