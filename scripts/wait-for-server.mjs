import http from 'node:http';

const target = process.argv[2] ?? 'http://127.0.0.1:4777/health';

function retry() {
  setTimeout(wait, 100);
}

function wait() {
  const req = http.get(target, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      process.exit(0);
      return;
    }
    retry();
  });
  req.setTimeout(500, () => {
    req.destroy();
    retry();
  });
  req.on('error', retry);
}

wait();
