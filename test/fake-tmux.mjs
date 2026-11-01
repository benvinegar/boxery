// A fake tmux for tests: models detach and session existence with an independently spawned
// process group, so the jobs protocol runs without a tmux install (macOS CI has none) and never
// touches the developer's real tmux server. Sessions live as pid files in $HOME/.test-tmux.
// Knobs: TMUX_FAIL (new-session fails), TMUX_LAUNCHED (write the id there, then hang as if
// new-session had not returned), TMUX_RUNNER_DELAY (seconds before the runner starts).
export const fakeTmux = () => `#!${process.execPath}
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const a = process.argv.slice(2), d = path.join(process.env.HOME, '.test-tmux');
fs.mkdirSync(d, {recursive:true});
if(a[0] === 'new-session') {
 if(process.env.TMUX_FAIL) process.exit(1);
 const id = a[a.indexOf('-s')+1], file = path.join(d,id), cmd = a.at(-1);
 fs.writeFileSync(file,'');
 const p = spawn('/bin/bash',['-c', ${JSON.stringify('while [ ! -s "$1" ]; do sleep 0.01; done; trap \'rm -f -- "$1"\' EXIT; sleep "${TMUX_RUNNER_DELAY:-0}"; /bin/bash -c "$2"')}, '--', file, cmd], {detached:true,stdio:'ignore'});
 fs.writeFileSync(file,String(p.pid)); p.unref();
 if(process.env.TMUX_LAUNCHED) {
  fs.writeFileSync(process.env.TMUX_LAUNCHED, id);
  setTimeout(() => {}, 30000); // Simulate launch complete but new-session not yet returned.
 }
} else if(a[0] === 'has-session') process.exit(fs.existsSync(path.join(d,a.at(-1).replace(/^=/,''))) ? 0 : 1);
else if(a[0] === 'kill-session') {
 const file = path.join(d,a.at(-1).replace(/^=/,''));
 if(fs.existsSync(file)) { try { process.kill(-Number(fs.readFileSync(file,'utf8')), 'SIGKILL'); } catch {} fs.unlinkSync(file); }
} else process.exit(1);
`;
