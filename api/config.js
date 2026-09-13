// Vercel Serverless Function: /api/config
// 프론트엔드에서 사용할 Supabase 클라이언트 공개 설정(URL, Anon Key)을 반환합니다.
const { getSupabaseUrl, getSupabaseKey } = require('../lib/supabase');

module.exports = async function handler(req, res) {
  const supabaseUrl = getSupabaseUrl() || '';
  const supabaseAnonKey = getSupabaseKey() || '';

  res.status(200).json({
    supabaseUrl,
    supabaseAnonKey
  });
};

