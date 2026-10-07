(function () {
  'use strict';
  var message = document.getElementById('message'), started = false, ready = false, checking = false;
  var retryPending = false, reconciling = false, currentStep = 0;
  var retryButton = document.getElementById('retry');
  retryButton.onclick = function () { if (window.PS4_STANDALONE) { location.replace('index.html'); return; } if (ready) { retryButton.hidden = true; progress('Package setup',null); packageSetup(true); } else location.replace('index.html'); };
  function say(s) { message.textContent = s; }
  function progress(label, value, failed) {
    var stage = document.getElementById('stage');
    stage.textContent = label;
    document.getElementById('percent').textContent = typeof value === 'number' ? Math.round(value) + '%' : '';
    if (ready) currentStep = 2;
    else if (label === 'Jailbreak') currentStep = 1;
    else if (label === 'Browser exploit' || label === 'Offline cache') currentStep = 0;
    var complete = ready && label === 'Ready' && value === 100 && !failed;
    for (var i = 0; i < 3; i++) document.getElementById('step' + i).className = 'segment' + (complete || i < currentStep ? ' done' : i === currentStep ? failed ? ' error' : ' active' : '');
    document.getElementById('success').hidden = !complete;
    retryButton.hidden = !failed || label === 'Unsupported firmware';
  }
  function packageSetup(retry) {
    if (window.PS4_STANDALONE) return;
    var req = new XMLHttpRequest(); req.open('POST', '/api/ready' + (retry ? '?retry=1' : '')); req.timeout = 6000;
    req.onload = function () { if (req.status === 202) poll(); else {say('Package setup unavailable. Keep the local server running.'); progress('Package setup', null, true);} };
    req.onerror = req.ontimeout = function () {say('Jailbreak finished. Package setup needs the local server.'); progress('Package setup',null,true);};
    req.send();
  }
  var match = /PlayStation\s+4[\/ ](\d+)\.(\d+)(?:\D|$)/.exec(navigator.userAgent);
  var supported = !!match && match[1] === '13' && match[2] === '52';
  var firmware = document.getElementById('firmware');
  firmware.textContent = 'Detected FW: ' + (match ? match[1] + '.' + match[2] : 'Unknown') + ' · ' + (supported ? 'Supported' : 'Unsupported');
  firmware.className = supported ? 'supported' : 'unsupported';
  if (!supported) { say('This page requires PS4 firmware 13.52.'); progress('Unsupported firmware',null,true); return; }
  window.hostEvent = function (tag, detail) {
    if (tag === 'CONSOLE-SETUP') {
      var job = JSON.parse(detail); say(job.message); progress(job.stage,job.progress,job.failed); return;
    }
    if (tag === 'AUTO-RETRY' && !ready) retryPending = true;
    if (!ready) {
      if (tag === 'PRIMITIVE-OK') { progress('Jailbreak',null); say('Browser exploit complete. Preparing system jailbreak…'); }
      if (tag === 'JB-ROOT') { progress('Jailbreak',null); say('Applying jailbreak…'); }
      else if (tag === 'KPATCH-PRE') say('Applying system patches…');
      else if (tag === 'PAYLOAD-RUN') say('Starting GoldHEN…');
      else if (tag === 'AUTO-RETRY') { progress('Browser exploit',null); say('Retrying jailbreak…'); }
    }
    if (tag === 'ALREADY-ROOT' || (tag === 'HOST-FINISHED' && detail === 'ok') || (tag === 'PROOF-OK' && /^PAYLOAD-RUNNING\b/.test(detail))) {
      if (ready) return;
      ready = true;
      retryPending = false;
      document.getElementById('retry').hidden = true;
      // Change the reopen/bookmark URL without unloading the running payload.
      try { window.history.replaceState(null, '', 'index.html'); } catch (e) {}
      say('Jailbreak active. Preparing PKG Manager…');
      progress('Package setup',null);
      setTimeout(function () {
        packageSetup(false);
      }, 5000);
    }
    if (!ready && !retryPending && (tag === 'THREW' || tag === 'ERROR' || (tag === 'HOST-FINISHED' && detail === 'failed'))) verifyOutcome();
  };
  function verifyOutcome() {
    if (window.PS4_STANDALONE) { say('Could not confirm jailbreak'); progress('Status unconfirmed',null,true); return; }
    if (reconciling || ready || retryPending) return;
    reconciling = true;
    say('Confirming console status…'); progress('Console check',null);
    var attempts = 0;
    function check() {
      if (ready || retryPending) return;
      attempts++;
      var req = new XMLHttpRequest(), handled = false;
      function finish(active) {
        if (handled) return; handled = true;
        if (ready || retryPending) return;
        if (active) { window.hostEvent('ALREADY-ROOT','Live service confirmed after chain exit'); return; }
        if (attempts < 3) {setTimeout(check,2000); return;}
        say('Could not confirm jailbreak. Check GoldHEN on the console before retrying.');
        progress('Status unconfirmed',null,true);
        document.getElementById('retry').hidden = false;
      }
      req.open('GET','/api/console'); req.timeout = 5000;
      req.onload = function () {try {finish(req.status === 200 && JSON.parse(req.responseText).active === true);} catch(e) {finish(false);}};
      req.onerror = req.ontimeout = function () {finish(false);}; req.send();
    }
    setTimeout(check,1000);
  }
  function poll() {
    var req = new XMLHttpRequest(); req.open('GET', '/api/job'); req.timeout = 6000;
    req.onload = function () {
      try {
        var job = JSON.parse(req.responseText); say(job.message);
        progress(job.stage || 'Package setup', job.progress, job.failed);
        if (!job.done) setTimeout(poll, 2500);
        else if (job.failed) {
          var retry = document.getElementById('retry'); retry.hidden = false;
          retry.onclick = function (e) {e.preventDefault(); retry.hidden = true; progress('Package setup',null); packageSetup(true);};
        }
      }
      catch (e) { say('Jailbreak finished. Package status unavailable.'); progress('Status unavailable',null,true); }
    };
    req.onerror = req.ontimeout = function () { say('Jailbreak finished. Package server disconnected.'); progress('Server disconnected',null,true); };
    req.send();
  }
  function launch() {
    if (started) return; started = true; say('Starting jailbreak…');
    if (!/\/jb\.html$/.test(location.pathname)) { location.replace('jb.html'); return; }
    progress('Browser exploit',null); say('Running browser exploit…');
    var script = document.createElement('script'); script.type = 'module'; script.src = 'jb.js';
    script.onerror = function () { say('Could not load jailbreak files. Reload to retry.'); progress('Browser exploit',null,true); };
    document.body.appendChild(script);
  }
  function checkThenLaunch() {
    if (window.PS4_STANDALONE) { launch(); return; }
    if (checking || started || ready) return;
    checking = true; say('Checking jailbreak status…');
    progress('Console check',null);
    var req = new XMLHttpRequest(), handled = false;
    function fallback() { if (handled) return; handled = true; launch(); }
    req.open('GET', '/api/console'); req.timeout = 5000;
    req.onload = function () {
      if (handled) return;
      try {
        var status = JSON.parse(req.responseText);
        if (req.status === 200 && status.active === true) { handled = true; window.hostEvent('ALREADY-ROOT', 'Live console service detected'); return; }
      } catch (e) {}
      fallback();
    };
    req.onerror = req.ontimeout = fallback;
    req.send();
  }
  // Run in a fresh document without a manifest-triggered cache download.
  if (/\/jb\.html$/.test(location.pathname)) { checkThenLaunch(); return; }
  var ac = window.applicationCache;
  if (!ac || !navigator.onLine) { launch(); return; }
  function updated() { try { ac.swapCache(); } catch (e) {} location.reload(); }
  ac.addEventListener('cached', launch); ac.addEventListener('noupdate', launch);
  ac.addEventListener('error', launch); ac.addEventListener('obsolete', launch);
  ac.addEventListener('updateready', updated);
  ac.addEventListener('downloading', function () { say('Saving for offline use…'); });
  ac.addEventListener('progress', function (e) { progress('Offline cache', e.total ? 100 * e.loaded / e.total : null); });
  setTimeout(function () {
    if (ac.status === ac.UPDATEREADY) updated();
    else if (ac.status !== ac.CHECKING && ac.status !== ac.DOWNLOADING) launch();
  }, 3000);
})();
