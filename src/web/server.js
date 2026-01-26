const express = require('express');

class HealthServer {
  constructor(port) {
    this.port = port || 8080;
    this.app = express();
    this.server = null;

    this.app.get('/', (_req, res) => {
      res.status(200).send('OK');
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`Health check server starting on port ${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = {
  HealthServer,
};


