// Supabase 클라이언트 설정 모듈
// Vercel 마켓플레이스 연동 환경변수를 자동으로 감지하여 Supabase 클라이언트를 초기화합니다.

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// 환경변수 로더 (Vercel 프로덕션 런타임 및 로컬 .env.* 지원)
function getEnvValue(key) {
  if (process.env[key] && process.env[key].trim() !== '') {
    return process.env[key].trim();
  }

  const envFiles = [
    '.env.production.local',
    '.env.local',
    '.env.development.local',
    '.env'
  ];

  for (const file of envFiles) {
    try {
      const filePath = path.join(process.cwd(), file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            const [k, ...vParts] = trimmed.split('=');
            if (k.trim() === key) {
              const val = vParts.join('=').trim().replace(/^['"]|['"]$/g, '');
              if (val && val !== '[SENSITIVE]') {
                return val;
              }
            }
          }
        }
      }
    } catch {
      // 파일 읽기 실패 무시
    }
  }

  return null;
}

// Supabase URL 조회 (SUPABASE_URL 또는 NEXT_PUBLIC_SUPABASE_URL)
function getSupabaseUrl() {
  return getEnvValue('SUPABASE_URL') || getEnvValue('NEXT_PUBLIC_SUPABASE_URL');
}

// Supabase Key 조회 (서버리스 전용 SERVICE_ROLE_KEY 우선, 없을 시 ANON_KEY)
function getSupabaseKey() {
  return (
    getEnvValue('SUPABASE_SERVICE_ROLE_KEY') ||
    getEnvValue('SUPABASE_SECRET_KEY') ||
    getEnvValue('SUPABASE_ANON_KEY') ||
    getEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY') ||
    getEnvValue('SUPABASE_PUBLISHABLE_KEY') ||
    getEnvValue('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  );
}

// 싱글톤 Supabase 클라이언트 인스턴스 (서버리스 환경에서 커넥션 재사용)
let supabaseInstance = null;

function getSupabaseClient() {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const supabaseUrl = getSupabaseUrl();
  const supabaseKey = getSupabaseKey();

  if (!supabaseUrl || !supabaseKey) {
    console.warn('[Supabase] SUPABASE_URL 또는 SUPABASE KEY 환경변수가 설정되지 않았습니다.');
    return null;
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false // 서버리스 환경에서는 세션 영속화 비활성화
    }
  });

  return supabaseInstance;
}

module.exports = {
  getSupabaseClient,
  getSupabaseUrl,
  getSupabaseKey
};
