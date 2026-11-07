// The named Cloudflare tunnel this machine is set up to run, read from ~/.cloudflared/config.yml.
//
// Shared by the launcher (scripts/start-all.js), which runs the tunnel, and the host keeper
// (scripts/host-keeper.js), which checks the site answers on the tunnel's public hostname -- so
// both agree on which hostname is this app's.

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * The hostname routed to OUR port, rather than whichever `hostname:` happens to come first.
 *
 * One tunnel can front several services -- a `hostname: files.example / service: http://…:3000`
 * rule sitting above ours is an ordinary config -- so the first hostname in the file is not
 * necessarily this app's. Printing that one as the address to share sends the party to someone
 * else's site, so match the rule by the port its `service:` dials and only fall back to "the
 * first hostname" when nothing routes here.
 */
function ingressHostname(cfg, port) {
  // Only the ingress block: a `- ` elsewhere in the file is some other list, not a routing rule.
  const rules = (cfg.split(/^ingress:[ \t]*$/m)[1] ?? '').split(/^\s*-\s+/m).slice(1);
  const field = (rule, key) => rule.match(new RegExp(`\\b${key}:\\s*(\\S+)`))?.[1] ?? null;
  // Substring rather than regex: WEB_PORT is whatever the environment says, and a port with a
  // regex metacharacter in it would otherwise match the wrong rule (or throw).
  const dialsUs = (rule) => {
    const service = field(rule, 'service') ?? '';
    return service.endsWith(`:${port}`) || service.endsWith(`:${port}/`);
  };
  const hosted = rules.filter((r) => field(r, 'hostname'));
  return field(hosted.find(dialsUs) ?? hosted[0] ?? '', 'hostname');
}

/**
 * The configured named tunnel as `{ name, hostname }`, or null if there isn't one.
 *
 * A quick tunnel mints a fresh random hostname on every launch, which is fine for one party and
 * useless as an address: the link you handed out last week is already dead. Once
 * `cloudflared tunnel login` and `tunnel create` have been run there is a `config.yml` naming a
 * persistent tunnel and the hostname routed to it, so prefer that whenever it exists.
 *
 * Read with a regex rather than a YAML dependency -- a handful of scalars do not justify a
 * parser -- and any failure falls through to the quick tunnel instead of taking the launcher
 * down with it.
 */
function namedTunnel(port) {
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.cloudflared', 'config.yml'), 'utf8');
    const name = cfg.match(/^\s*tunnel:\s*(\S+)/m)?.[1];
    // `<UUID>` still sitting there means the template was copied but never filled in. cloudflared
    // reports that as a credentials error much further along, so catch it here where it is obvious.
    if (!name || name.startsWith('<')) return null;
    return { name, hostname: ingressHostname(cfg, port) };
  } catch {
    return null;
  }
}

module.exports = { ingressHostname, namedTunnel };
