require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const {
  CAFE24_MALL_ID,
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_REDIRECT_URI,
  CAFE24_API_VERSION,
} = process.env;

const CAFE24_API_BASE = `https://${CAFE24_MALL_ID}.cafe24api.com/api/v2`;

// ─────────────────────────────────────────────
// ✅ 토큰 저장소 (서버 메모리)
// ─────────────────────────────────────────────
let tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null,
};

// ─────────────────────────────────────────────
// [유틸] 토큰 저장 및 로그 출력
// ─────────────────────────────────────────────
function saveToken(data) {
  tokenStore.access_token = data.access_token;
  tokenStore.refresh_token = data.refresh_token;
  tokenStore.expires_at = new Date(Date.now() + data.expires_in * 1000);

  console.log("--------------------------------------------------");
  console.log("🟢 [TOKEN SAVE] 토큰 저장 완료");
  console.log(
    " - Access Token (앞10자):",
    tokenStore.access_token.substring(0, 10) + "...",
  );
  console.log(" - 만료 시각:", tokenStore.expires_at.toLocaleString());
  console.log("--------------------------------------------------");
}

// ─────────────────────────────────────────────
// [유틸] 유효한 access_token 가져오기 (갱신 로직 포함)
// ─────────────────────────────────────────────
async function getValidAccessToken() {
  console.log("🔍 [TOKEN CHECK] 토큰 유효성 검사 시작...");

  if (!tokenStore.access_token) {
    console.error("❌ [TOKEN ERROR] 서버에 저장된 토큰이 없습니다.");
    throw new Error("NO_TOKEN");
  }

  const fiveMinutes = 5 * 60 * 1000;
  const isExpired = tokenStore.expires_at
    ? Date.now() > tokenStore.expires_at - fiveMinutes
    : false;

  if (isExpired) {
    console.log("🔄 [TOKEN REFRESH] 토큰 만료 임박 - 갱신 요청 중...");
    try {
      const credentials = Buffer.from(
        `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`,
      ).toString("base64");

      const response = await axios.post(
        `${CAFE24_API_BASE}/oauth/token`,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenStore.refresh_token,
        }).toString(),
        {
          headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
        },
      );

      saveToken(response.data);
      console.log("✅ [TOKEN REFRESH] 성공");
    } catch (err) {
      console.error(
        "❌ [TOKEN REFRESH ERROR] 실패:",
        err.response?.data || err.message,
      );
      throw err;
    }
  } else {
    console.log("✅ [TOKEN CHECK] 기존 토큰 사용 가능");
  }

  return tokenStore.access_token;
}

// ─────────────────────────────────────────────
// [유틸] 카페24 Admin API 공통 요청 함수
// ─────────────────────────────────────────────
async function cafe24AdminRequest(accessToken, endpoint, params = {}) {
  console.log(`📡 [CAFE24 API CALL] ${endpoint}`);
  const response = await axios.get(`${CAFE24_API_BASE}${endpoint}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Cafe24-Api-Version": CAFE24_API_VERSION,
    },
    params,
  });
  return response.data;
}

// ─────────────────────────────────────────────
// [유틸] 쿠폰 데이터 정규화
// ─────────────────────────────────────────────
function normalizeCoupon(coupon) {
  const now = new Date();
  const endDate = coupon.available_end_datetime
    ? new Date(coupon.available_end_datetime)
    : null;

  let discount = {};
  switch (coupon.benefit_type) {
    case "A":
      discount = {
        type: "fixed",
        label: "정액할인",
        amount: Number(coupon.benefit_price ?? 0),
      };
      break;
    case "B":
      discount = {
        type: "percentage",
        label: "정률할인",
        percentage: Number(coupon.benefit_percentage ?? 0),
        max_price: coupon.benefit_percentage_max_price
          ? Number(coupon.benefit_percentage_max_price)
          : null,
      };
      break;
    case "C":
      discount = {
        type: "shipping",
        label: "배송비할인",
        amount: Number(coupon.benefit_price ?? 0),
      };
      break;
    default:
      discount = { type: "unknown", label: "기타", amount: 0 };
  }

  const hasMinPrice = coupon.available_price_type === "O";

  return {
    coupon_no: coupon.coupon_no,
    coupon_name: coupon.coupon_name,
    discount,
    conditions: {
      has_min_price: hasMinPrice,
      min_price: hasMinPrice ? Number(coupon.available_min_price ?? 0) : 0,
    },
    validity: {
      is_available: endDate ? endDate >= now : true,
      end_datetime: coupon.available_end_datetime,
    },
  };
}

// ─────────────────────────────────────────────
// 1. 앱 설치 시작 (OAuth 인증 유도)
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  const { mall_id } = req.query;
  console.log("🚀 [INSTALL] 앱 설치/인증 요청 수신. Mall ID:", mall_id);

  const targetMall = mall_id || CAFE24_MALL_ID;
  const authUrl =
    `https://${targetMall}.cafe24api.com/api/v2/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${CAFE24_CLIENT_ID}` +
    `&redirect_uri=${CAFE24_REDIRECT_URI}` +
    `&scope=mall.read_promotion`;

  console.log("🔗 [AUTH URL] 생성됨:", authUrl);
  res.redirect(authUrl);
});

// ─────────────────────────────────────────────
// 2. OAuth 콜백 (토큰 획득 및 저장)
// ─────────────────────────────────────────────
app.get("/api/auth/callback", async (req, res) => {
  const { code } = req.query;
  console.log("📥 [CALLBACK] 카페24로부터 인증 코드(Code) 수신:", code);

  if (!code) {
    console.error("❌ [CALLBACK ERROR] Code가 전달되지 않았습니다.");
    return res.status(400).send("Code missing");
  }

  try {
    const credentials = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`,
    ).toString("base64");

    console.log("🚀 [OAUTH] Access Token 교환 요청 시작...");
    const response = await axios.post(
      `${CAFE24_API_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: CAFE24_REDIRECT_URI,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    saveToken(response.data);
    res.send(
      "<h2>✅ 앱 설치 및 토큰 발급 완료!</h2><p>이제 쿠폰 조회가 가능합니다.</p>",
    );
  } catch (err) {
    console.error(
      "❌ [CALLBACK ERROR] 토큰 교환 실패:",
      err.response?.data || err.message,
    );
    res
      .status(500)
      .json({ error: "토큰 발급 실패", detail: err.response?.data });
  }
});

// ─────────────────────────────────────────────
// 3. 메인 API: 회원 쿠폰 목록 조회
// ─────────────────────────────────────────────
app.get("/api/coupons/:member_id", async (req, res) => {
  const { member_id } = req.params;
  const { shop_no = 1 } = req.query;

  console.log("==================================================");
  console.log(`📡 [API REQUEST] 쿠폰 조회 실행`);
  console.log(` - ID: ${member_id}`);
  console.log(` - Shop No: ${shop_no}`);
  console.log("==================================================");

  try {
    const accessToken = await getValidAccessToken();

    let allCoupons = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      console.log(`   * 데이터 수집 중... (Offset: ${offset})`);
      const data = await cafe24AdminRequest(
        accessToken,
        `/admin/customers/${member_id}/coupons`,
        { shop_no, limit, offset },
      );

      const coupons = data.coupons ?? [];
      allCoupons = allCoupons.concat(coupons);

      if (coupons.length < limit) break;
      offset += limit;
      if (offset >= 1000) break; // 무한루프 방지 안전장치
    }

    const normalized = allCoupons
      .map(normalizeCoupon)
      .filter((c) => c.validity.is_available);

    console.log(`✅ [SUCCESS] 조회 완료. 유효 쿠폰 수: ${normalized.length}`);
    return res.json({
      member_id,
      total_count: normalized.length,
      coupons: normalized,
    });
  } catch (err) {
    console.error("❌ [API ERROR] 처리 실패");

    if (err.message === "NO_TOKEN") {
      console.error(" > 원인: 서버에 저장된 토큰이 없음 (재인증 필요)");
      return res
        .status(401)
        .json({ error: "토큰이 없습니다. 앱 설치를 진행하세요." });
    }

    const errorStatus = err.response?.status || 500;
    const errorData = err.response?.data || err.message;

    console.error(` > 상태코드: ${errorStatus}`);
    console.error(` > 상세내용:`, JSON.stringify(errorData, null, 2));

    return res.status(errorStatus).json({
      error: "쿠폰 조회 실패",
      detail: errorData,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  🚀 서버 구동 완료!
  - 로컬 주소: http://localhost:${PORT}
  - API 엔드포인트: /api/coupons/:member_id
  --------------------------------------------------
  `);
});
