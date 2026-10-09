#!/usr/bin/env python3
"""Asset server of a GPU bench session: files for the harness page, on 127.0.0.1.

The harness page (http://localhost:5173) is cross-origin isolated (COEP
require-corp), so every response carries Access-Control-Allow-Origin: *,
Cross-Origin-Resource-Policy: cross-origin and Cache-Control: no-store: the
page's fetch() gets the bytes as they are now. It binds 127.0.0.1 only.

  asset-server.py [--port N] [--root DIR] [--map URLPATH=FILE]...
                  [--git URLPATH=REV:PATH]... [--repo DIR] [--check] [FILE]

  --port N      the port (default 8765).
  --root DIR    serves the files under DIR, read at each request (default:
                docs/plans/assets of the repo). Nothing outside DIR (no '..',
                no symlink out of it), no directory listings.
  --map U=F     serves FILE at URL path U, read at each request.
  --git U=R:P   serves PATH as it is at git revision R, read once at start
                (`git show R:P`), e.g. a shader before a change:
                --git /old-light-accum.wgsl=1d19575:ts/src/shaders/light-accum.wgsl
  --repo DIR    the repository of --git and of the default --root (default:
                $HYPERION_ROOT, else $CLAUDE_PROJECT_DIR, else the repo this
                script is in).
  --check       checks the arguments, prints what it would serve, and exits
                (0, or 2 on a bad argument) without binding the port.
  FILE          the round-step-7 form: the same as --map /old-light-accum.wgsl=FILE.

A mapped URL path (--map, --git, FILE) wins over a file of the same name under
--root. Types: .js/.mjs text/javascript, .json application/json, .wgsl and
.txt text/plain, .md text/markdown, .png image/png, anything else
application/octet-stream; from the URL path's extension, else from the served
file's (the FILE of --map, the PATH of --git), so --git /old-x=REV:x.wgsl is
text/plain too. One log line per request on stderr. gpu-infra.sh up
starts it (with HYPERION_ROOT set) and gpu-infra.sh down stops it:
.claude/skills/gpu-check/SKILL.md, "Bench session". Python 3.8+, stdlib only.
"""
import argparse
import http.server
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.parse

HOST = '127.0.0.1'
DEFAULT_PORT = 8765
LEGACY_URL = '/old-light-accum.wgsl'
TEXT = 'text/plain; charset=utf-8'
TYPES = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wgsl': TEXT,
    '.txt': TEXT,
    '.md': 'text/markdown; charset=utf-8',
    '.png': 'image/png',
}
OCTET = 'application/octet-stream'


def log(message):
    sys.stderr.write(message + '\n')
    sys.stderr.flush()


def fail(message):
    log('asset-server: error: ' + message)
    sys.exit(2)


def content_type(*names):
    """The type of the first name whose extension is known."""
    for name in names:
        ext = os.path.splitext(name)[1].lower()
        if ext in TYPES:
            return TYPES[ext]
    return OCTET


def default_repo():
    for var in ('HYPERION_ROOT', 'CLAUDE_PROJECT_DIR'):
        if os.environ.get(var):
            return os.environ[var]
    # .claude/skills/gpu-check/scripts/asset-server.py: the repo is four levels up.
    here = os.path.dirname(os.path.realpath(__file__))
    return os.path.join(here, os.pardir, os.pardir, os.pardir, os.pardir)


def url_path(text, flag):
    path = text if text.startswith('/') else '/' + text
    if path == '/' or '?' in path or '#' in path:
        fail('%s: %r is not a file URL path (e.g. /old-light-accum.wgsl)' % (flag, text))
    return path


# A mapped entry: (kind, value, label, source name). kind 'file': value is the
# file's path, read at each request; kind 'git': value is the bytes read at
# start. The source name (the file, the git PATH) types a URL path that has no
# known extension of its own.
def file_entry(path, flag):
    full = os.path.abspath(path)
    if not os.path.isfile(full):
        fail('%s: %s is not a file' % (flag, full))
    return ('file', full, full, full)


def git_entry(repo, revpath, flag):
    rev, sep, path = revpath.partition(':')
    if not sep or not rev or not path:
        fail('%s: %r is not REV:PATH' % (flag, revpath))

    def git(*args):
        try:
            return subprocess.run(['git', '-C', repo, '--no-pager'] + list(args),
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as err:
            fail('%s: cannot run git: %s' % (flag, err))

    kind = git('cat-file', '-t', revpath)
    if kind.returncode != 0:
        detail = kind.stderr.decode('utf-8', 'replace').strip()
        fail('%s: %s in %s: %s' % (flag, revpath, repo, detail or 'not found'))
    kind = kind.stdout.decode().strip()
    if kind != 'blob':
        fail('%s: %s is a %s, not a file' % (flag, revpath, kind))
    shown = git('show', revpath)
    if shown.returncode != 0:
        fail('%s: git show %s: %s' % (flag, revpath, shown.stderr.decode('utf-8', 'replace').strip()))
    blob = git('rev-parse', '--verify', revpath).stdout.decode().strip()
    label = 'git %s (blob %s)' % (revpath, blob[:12])
    return ('git', shown.stdout, label, path)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    root = ''
    mapped = {}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'hyperion-asset-server/1'

    def version_string(self):
        # The Server header: this name alone (the base class appends ' ' and
        # the Python version).
        return self.server_version

    def end_headers(self):
        # On every response, errors included: the page is cross-origin isolated.
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_request(self, code='-', size='-'):
        pass  # respond() writes the one line of each request

    def log_message(self, fmt, *args):
        log('[%s] %s' % (time.strftime('%H:%M:%S'), fmt % args))

    def respond(self, code, body, ctype, source, headers=()):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)
        log('[%s] %s %s -> %d %d B  %s' % (time.strftime('%H:%M:%S'), self.command or '-',
                                           getattr(self, 'path', '-'), int(code), len(body), source))

    def send_error(self, code, message=None, explain=None):
        # BaseHTTPRequestHandler's own errors (bad request line, unknown method).
        self.close_connection = True
        reason = message or self.responses.get(code, ('error',))[0]
        self.respond(code, ('%d %s\n' % (int(code), reason)).encode(), TEXT, reason)

    def do_OPTIONS(self):
        self.respond(204, b'', TEXT, 'preflight',
                     (('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'),
                      ('Access-Control-Allow-Headers', '*')))

    def do_GET(self):
        self.serve()

    def do_HEAD(self):
        self.serve()

    def serve(self):
        path = urllib.parse.unquote(self.path.split('?', 1)[0].split('#', 1)[0])
        if '\x00' in path:
            return self.respond(400, b'400 bad path\n', TEXT, 'refused: NUL in the path')
        entry = self.server.mapped.get(path)
        if entry is not None:
            kind, value, label, source = entry
            ctype = content_type(path, source)
            if kind == 'git':
                return self.respond(200, value, ctype, label)
            try:
                with open(value, 'rb') as f:
                    body = f.read()
            except OSError as err:
                return self.respond(404, b'404 not found\n', TEXT, 'map %s: %s' % (value, err))
            return self.respond(200, body, ctype, 'map ' + value)
        root = self.server.root
        full = os.path.realpath(os.path.join(root, path.lstrip('/')))
        if os.path.commonpath([root, full]) != root:
            return self.respond(403, b'403 outside the served root\n', TEXT, 'refused: outside ' + root)
        if not os.path.isfile(full):
            return self.respond(404, b'404 not found\n', TEXT, 'not a file under the root')
        try:
            with open(full, 'rb') as f:
                body = f.read()
        except OSError as err:
            return self.respond(404, b'404 not found\n', TEXT, str(err))
        return self.respond(200, body, content_type(full), 'root ' + os.path.relpath(full, root))


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='asset-server.py', allow_abbrev=False,
        description=__doc__.split('\n\n', 1)[1],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--root')
    parser.add_argument('--map', action='append', default=[], metavar='URLPATH=FILE')
    parser.add_argument('--git', action='append', default=[], metavar='URLPATH=REV:PATH')
    parser.add_argument('--repo')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('file', nargs='?', metavar='FILE')
    args = parser.parse_args(argv)

    if not 0 < args.port < 65536:
        fail('--port %d is not a port' % args.port)
    repo = os.path.realpath(args.repo or default_repo())
    root = os.path.realpath(args.root or os.path.join(repo, 'docs', 'plans', 'assets'))
    if not os.path.isdir(root):
        fail('--root %s is not a directory' % root)

    mapped = {}

    def add(url, entry):
        if url in mapped:
            fail('%s is mapped twice' % url)
        mapped[url] = entry

    if args.file:
        add(LEGACY_URL, file_entry(args.file, 'FILE'))
    for spec in args.map:
        url, sep, path = spec.partition('=')
        if not sep or not url or not path:
            fail('--map %r is not URLPATH=FILE' % spec)
        add(url_path(url, '--map'), file_entry(path, '--map'))
    for spec in args.git:
        url, sep, revpath = spec.partition('=')
        if not sep or not url or not revpath:
            fail('--git %r is not URLPATH=REV:PATH' % spec)
        add(url_path(url, '--git'), git_entry(repo, revpath, '--git'))

    plan = ['asset-server: http://%s:%d/' % (HOST, args.port), '  root  %s' % root]
    for url in sorted(mapped):
        kind, value, label, source = mapped[url]
        size = len(value) if kind == 'git' else os.path.getsize(value)
        plan.append('  %s  %s -> %s, %d bytes, %s' % ('git ' if kind == 'git' else 'map ', url, label, size,
                                                     content_type(url, source).split(';')[0]))
    if args.check:
        print('\n'.join(plan))
        return 0

    try:  # a listener on the wildcard address would take our requests
        with socket.create_connection((HOST, args.port), timeout=0.5):
            fail('%s:%d is already in use' % (HOST, args.port))
    except OSError:
        pass
    try:
        server = Server((HOST, args.port), Handler)
    except OSError as err:
        fail('cannot listen on %s:%d: %s' % (HOST, args.port, err))
    server.root = root
    server.mapped = mapped
    for line in plan:
        log(line)
    log('asset-server: listening, pid %d' % os.getpid())
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        log('asset-server: stopped')
    return 0


if __name__ == '__main__':
    sys.exit(main())
