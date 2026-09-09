module.exports = {
  root: true,
  extends: '@react-native',
  rules: {
    // `void somePromise()` is how this codebase marks a deliberately unawaited
    // call — the heartbeat, a refresh, a settlement kicked off from an event
    // handler. The alternative the rule pushes you towards is a bare floating
    // promise, which is the thing that actually hides bugs. Turned off rather
    // than suppressed at ~7 call sites.
    'no-void': 'off',
  },
};
