const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function getPgConfig() {
  const rawUrl = process.env.DATABASE_URL || '';
  if (!rawUrl) {
    return { connectionString: '' };
  }
  // sslmode=require በ connection string ውስጥ ካለ pg ከ ssl option ጋር እንዳይጋጭ ያስተካክላል
  const cleanUrl = rawUrl.replace(/([?&])sslmode=[^&]*(&|$)/, (match, prefix, suffix) => {
    return suffix ? prefix : '';
  }).replace(/[?&]$/, '');

  return {
    connectionString: cleanUrl,
    ssl: {
      rejectUnauthorized: false,
    },
  };
}

const pool = new Pool(getPgConfig());
