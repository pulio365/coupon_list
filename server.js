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
// Render 재시작되면 사라지지만 테스트용으로는 충분
// 실서비스라면 DB(MySQL, Redis 등)에 저장하세요
// ─────────────────────────────────────────────
let tokenStore = {
  access_token: null,
  refresh_token: null,
  expires_at: null, // 만료 시각 (Date 객체)
};

// ─────────────────────────────────────────────
// [유틸] 토큰 저장
// ─────────────────────────────────────────────
function saveToken(data) {
  tokenStore.access_token = data.access_token;
  tokenStore.refresh_token = data.refresh_token;
  // expires_in은 초 단위 (카페24는 보통 7200초 = 2시간)
  tokenStore.expires_at = new Date(Date.now() + data.expires_in * 1000);
  console.log("✅ 토큰 저장 완료! 만료시각:", tokenStore.expires_at);
}

// ─────────────────────────────────────────────
// [유틸] 유효한 access_token 가져오기
// 만료됐으면 refresh_token으로 자동 갱신
// ─────────────────────────────────────────────
async function getValidAccessToken() {
  // 토큰 자체가 없으면 앱 설치 안 된 것
  if (!tokenStore.access_token) {
    throw new Error("NO_TOKEN");
  }

  // 만료 5분 전부터 미리 갱신
  const fiveMinutes = 5 * 60 * 1000;
  const isExpired = tokenStore.expires_at
    ? Date.now() > tokenStore.expires_at - fiveMinutes
    : false;

  if (isExpired) {
    console.log("🔄 토큰 만료 임박 - 자동 갱신 중...");
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
    console.log("✅ 토큰 자동 갱신 완료!");
  }

  return tokenStore.access_token;
}

// ─────────────────────────────────────────────
// [유틸] 카페24 Admin API 공통 요청
// ─────────────────────────────────────────────
async function cafe24AdminRequest(accessToken, endpoint, params = {}) {
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
// [유틸] 쿠폰 응답 정규화
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
        percentage: null,
        percentage_round_unit: null,
        max_price: null,
      };
      break;
    case "B":
      discount = {
        type: "percentage",
        label: "정률할인",
        amount: null,
        percentage: Number(coupon.benefit_percentage ?? 0),
        percentage_round_unit: Number(
          coupon.benefit_percentage_round_unit ?? 1,
        ),
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
        percentage: null,
        percentage_round_unit: null,
        max_price: null,
      };
      break;
    case "D":
      discount = {
        type: "credit",
        label: "적립금",
        amount: Number(coupon.credit_amount ?? 0),
        percentage: null,
        percentage_round_unit: null,
        max_price: null,
      };
      break;
    default:
      discount = { type: "unknown", label: "기타", amount: 0 };
  }

  const hasMinPrice = coupon.available_price_type === "O";

  return {
    coupon_no: coupon.coupon_no,
    issue_no: coupon.issue_no,
    coupon_name: coupon.coupon_name,
    shop_no: coupon.shop_no,
    discount,
    conditions: {
      has_min_price: hasMinPrice,
      min_price: hasMinPrice ? Number(coupon.available_min_price ?? 0) : 0,
      available_payment_methods: coupon.available_payment_methods ?? [],
    },
    validity: {
      issued_date: coupon.issued_date,
      begin_datetime: coupon.available_begin_datetime,
      end_datetime: coupon.available_end_datetime,
      is_expired: endDate ? endDate < now : false,
      is_available: endDate ? endDate >= now : true,
    },
  };
}

// ─────────────────────────────────────────────
// 앱 설치 시작
// 카페24 개발자센터 테스트실행 → 여기로 먼저 옴
// ─────────────────────────────────────────────
app.get("/", (req, res) => {
  const { mall_id } = req.query;

  const authUrl =
    `https://${mall_id}.cafe24api.com/api/v2/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${CAFE24_CLIENT_ID}` +
    `&redirect_uri=${CAFE24_REDIRECT_URI}` +
    `&scope=mall.read_promotion`;

  res.redirect(authUrl);
});

// ─────────────────────────────────────────────
// ✅ OAuth 콜백: code → access_token 교환 후 저장
// ─────────────────────────────────────────────
app.get("/api/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code가 없습니다." });

  try {
    const credentials = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`,
    ).toString("base64");

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

    // ✅ 핵심! 서버에 토큰 저장
    saveToken(response.data);

    // 설치 완료 페이지 보여주기
    res.send(`
      <h2>✅ 앱 설치 완료!</h2>
      <p>이제 쿠폰 조회 API를 사용할 수 있습니다.</p>
      <p>이 창을 닫아도 됩니다.</p>
    `);
  } catch (err) {
    console.error("[콜백 오류]", err.response?.data || err.message);
    return res.status(500).json({
      error: "토큰 발급 실패",
      detail: err.response?.data,
    });
  }
});

// ─────────────────────────────────────────────
// ✅ 핵심 API: 회원 쿠폰 목록 조회
//
// 프론트에서 호출:
//   GET /api/coupons/{member_id}
//   (토큰은 서버가 알아서 관리 - 프론트는 신경 안 써도 됨)
// ─────────────────────────────────────────────
app.get("/api/coupons/:member_id", async (req, res) => {
  const { member_id } = req.params;
  const { shop_no = 1 } = req.query;

  try {
    // ✅ 저장된 토큰 꺼내오기 (만료시 자동 갱신)
    const accessToken = await getValidAccessToken();

    // 페이지네이션으로 전체 쿠폰 수집
    let allCoupons = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await cafe24AdminRequest(
        accessToken,
        `/admin/customers/${member_id}/coupons`,
        { shop_no, limit, offset },
      );

      const coupons = data.coupons ?? [];
      allCoupons = allCoupons.concat(coupons);

      if (coupons.length < limit) break;
      offset += limit;
      if (offset >= 10000) break;
    }

    const normalized = allCoupons
      .map(normalizeCoupon)
      .filter((c) => c.validity.is_available);

    return res.json({
      member_id,
      shop_no,
      total_count: normalized.length,
      coupons: normalized,
    });
  } catch (err) {
    // 토큰 없음 = 앱 설치 안 됨
    if (err.message === "NO_TOKEN") {
      return res.status(401).json({ error: "앱 설치가 필요합니다." });
    }
    console.error("[쿠폰 조회 오류]", err.response?.data || err.message);
    return res.status(500).json({
      error: "쿠폰 조회 실패",
      detail: err.response?.data,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
