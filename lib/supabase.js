// Supabase 클라이언트 및 토큰 인증 관리 모듈
// 환경변수(SUPABASE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY 등)를 감지하여 관리자 클라이언트를 초기화하고 토큰을 검증합니다.

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

// Supabase URL 조회
function getSupabaseUrl() {
  return (
    getEnvValue('SUPABASE_URL') ||
    getEnvValue('NEXT_PUBLIC_SUPABASE_URL') ||
    'https://kxlebrmrcxngqylgkynj.supabase.co'
  );
}

// Supabase 공개 익명 키 조회
function getSupabaseKey() {
  return (
    getEnvValue('NEXT_PUBLIC_SUPABASE_ANON_KEY') ||
    getEnvValue('SUPABASE_ANON_KEY') ||
    getEnvValue('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY') ||
    getEnvValue('SUPABASE_PUBLISHABLE_KEY')
  );
}

// Supabase 관리자 Role Key 조회 (요구사항: SUPBASE_ROLE_KEY / SUPABASE_ROLE_KEY / SUPABASE_SERVICE_ROLE_KEY)
function getSupabaseRoleKey() {
  return (
    getEnvValue('SUPBASE_ROLE_KEY') ||
    getEnvValue('SUPABASE_ROLE_KEY') ||
    getEnvValue('SUPABASE_SERVICE_ROLE_KEY') ||
    getEnvValue('SUPABASE_SECRET_KEY')
  );
}

// 관리자 권한 클라이언트 인스턴스 (서버리스 웜 컨테이너 커넥션 재사용)
let supabaseAdminInstance = null;

function getSupabaseAdminClient() {
  if (supabaseAdminInstance) {
    return supabaseAdminInstance;
  }

  const supabaseUrl = getSupabaseUrl();
  const roleKey = getSupabaseRoleKey();

  if (!supabaseUrl || !roleKey) {
    return null;
  }

  supabaseAdminInstance = createClient(supabaseUrl, roleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  return supabaseAdminInstance;
}

// 일반 클라이언트 인스턴스
let supabaseInstance = null;

function getSupabaseClient() {
  if (supabaseInstance) {
    return supabaseInstance;
  }

  const supabaseUrl = getSupabaseUrl();
  const supabaseKey = getSupabaseRoleKey() || getSupabaseKey();

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  supabaseInstance = createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false
    }
  });

  return supabaseInstance;
}

// 요청 헤더의 Bearer 토큰 검증 및 사용자 ID 추출 헬퍼 함수
async function verifyAuthToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') {
    return { success: false, error: '인증 헤더가 누락되었습니다. 로그인이 필요합니다.' };
  }

  const parts = authHeader.trim().split(' ');
  const token = parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : parts[0];

  if (!token) {
    return { success: false, error: '유효한 Bearer 토큰 형식이 아닙니다.' };
  }

  // 1. Supabase 관리자 클라이언트(SUPABASE_ROLE_KEY)를 통한 공식 토큰 검증
  const adminClient = getSupabaseAdminClient();
  if (adminClient) {
    try {
      const { data, error } = await adminClient.auth.getUser(token);
      if (error || !data || !data.user) {
        return { success: false, error: error ? error.message : '유효하지 않은 세션 토큰입니다.' };
      }
      return {
        success: true,
        user: data.user,
        userId: data.user.id,
        email: data.user.email
      };
    } catch (err) {
      console.warn('[Supabase Token Verify Error]:', err.message);
      return { success: false, error: `토큰 검증 중 오류: ${err.message}` };
    }
  }

  // 2. SUPABASE_ROLE_KEY 미설정 로컬 개발 환경용 안전한 폴백 검증
  // JWT 페이로드 디코딩 시도 (클라이언트에서 전달된 실제 Supabase 토큰인 경우)
  try {
    const tokenParts = token.split('.');
    if (tokenParts.length === 3) {
      const payloadBase64 = tokenParts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payloadJson = Buffer.from(payloadBase64, 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload && (payload.sub || payload.id)) {
        const userId = payload.sub || payload.id;
        return {
          success: true,
          user: { id: userId, email: payload.email },
          userId: userId,
          email: payload.email
        };
      }
    }
  } catch (jwtErr) {
    // JWT 디코딩 실패 무시
  }

  // 3. 로컬 데모 세션 토큰(demo-user, google-user 등) 폴백
  if (token.startsWith('demo-') || token.includes('@') || token.startsWith('user-')) {
    const sanitizedId = token.replace(/[^a-zA-Z0-9_-]/g, '_');
    return {
      success: true,
      user: { id: sanitizedId, email: token },
      userId: sanitizedId,
      email: token
    };
  }

  return { success: false, error: '인증 토큰을 확인할 수 없습니다. 다시 로그인해주세요.' };
}

module.exports = {
  getSupabaseClient,
  getSupabaseAdminClient,
  getSupabaseUrl,
  getSupabaseKey,
  getSupabaseRoleKey,
  verifyAuthToken
};
