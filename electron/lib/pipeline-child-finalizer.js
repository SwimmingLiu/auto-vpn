export function attachPipelineChildFinalizer(
  child,
  {
    decoder,
    clearStopTimer,
    releaseActiveChild,
    isStopRequested,
    emit
  }
) {
  let finalized = false;

  const finalize = (payload) => {
    if (finalized) {
      return;
    }
    finalized = true;
    decoder.flush();
    clearStopTimer();
    releaseActiveChild();
    emit({ type: 'finished', ...payload });
  };

  child.on('error', (error) => {
    finalize({
      ok: false,
      code: null,
      signal: null,
      stopped: isStopRequested(),
      error: error.message
    });
  });

  child.on('close', (code, signal) => {
    const stopped = isStopRequested() || signal === 'SIGTERM' || signal === 'SIGKILL';
    finalize({
      ok: code === 0 && !stopped,
      code,
      signal,
      stopped
    });
  });
}
