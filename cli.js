#!/usr/bin/env node
const { SwaggerAnalyzer } = require('./dist/main.js');
const { resolve } = require("path");

const userPattern = process.argv[2];

const analyzer = new SwaggerAnalyzer({
  interactive: true,
  fileIncludePattern: userPattern ? `${resolve('./')}/${userPattern}` : undefined,
});

analyzer.run();
