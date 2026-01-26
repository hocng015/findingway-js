class Logger {
  constructor(level = Logger.levels.INFO, output = console) {
    this.level = level;
    this.output = output;
  }

  static get levels() {
    return {
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3,
    };
  }

  debug(message, ...args) {
    if (this.level <= Logger.levels.DEBUG) {
      this.output.debug(`[DEBUG] ${message}`, ...args);
    }
  }

  info(message, ...args) {
    if (this.level <= Logger.levels.INFO) {
      this.output.info(`[INFO] ${message}`, ...args);
    }
  }

  warn(message, ...args) {
    if (this.level <= Logger.levels.WARN) {
      this.output.warn(`[WARN] ${message}`, ...args);
    }
  }

  error(message, ...args) {
    if (this.level <= Logger.levels.ERROR) {
      this.output.error(`[ERROR] ${message}`, ...args);
    }
  }

  withField() {
    return this;
  }

  withFields() {
    return this;
  }

  static newDefault() {
    return new Logger(Logger.levels.INFO, console);
  }
}

module.exports = {
  Logger,
};


