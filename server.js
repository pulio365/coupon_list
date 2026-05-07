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
  CAFE24_API_VERSION, // 예: 2024-06-01
} = process.env;

const CAFE24_API_BASE = `https://${CAFE24_MALL_ID}.cafe24api.com/api/v2`;

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
// [유틸] 실제 API 응답 → 프론트 친화적 구조로 정규화
// benefit_type: A(정액할인), B(정률할인), C(배송비할인), D(적립금)
// available_price_type: U(무조건), O(주문금액 조건)
// ─────────────────────────────────────────────
function normalizeCoupon(coupon) {
  const now = new Date();
  const endDate = coupon.available_end_datetime
    ? new Date(coupon.available_end_datetime)
    : null;

  // 할인 정보 정규화
  let discount = {};
  switch (coupon.benefit_type) {
    case "A": // 정액 할인
      discount = {
        type: "fixed", // 정액
        label: "정액할인",
        amount: Number(coupon.benefit_price ?? 0),
        percentage: null,
        percentage_round_unit: null,
        max_price: null,
      };
      break;
    case "B": // 정률(%) 할인
      discount = {
        type: "percentage", // 정률
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
    case "C": // 배송비 할인
      discount = {
        type: "shipping",
        label: "배송비할인",
        amount: Number(coupon.benefit_price ?? 0),
        percentage: null,
        percentage_round_unit: null,
        max_price: null,
      };
      break;
    case "D": // 적립금
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

  // 최소 주문금액 조건
  const hasMinPrice = coupon.available_price_type === "O";

  return {
    // 식별 정보
    coupon_no: coupon.coupon_no,
    issue_no: coupon.issue_no,
    coupon_name: coupon.coupon_name,
    shop_no: coupon.shop_no,

    // 할인 혜택
    discount,

    // 사용 조건
    conditions: {
      has_min_price: hasMinPrice, // 최소 금액 조건 있는지
      min_price: hasMinPrice ? Number(coupon.available_min_price ?? 0) : 0,
      available_payment_methods: coupon.available_payment_methods ?? [], // 결제수단 제한
    },

    // 유효기간
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
// OAuth: Authorization Code → Token 교환
// GET /api/auth/callback?code=xxx
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
    return res.json(response.data); // access_token, refresh_token 반환
  } catch (err) {
    return res
      .status(500)
      .json({ error: "토큰 발급 실패", detail: err.response?.data });
  }
});

// ─────────────────────────────────────────────
// Token 갱신
// POST /api/auth/refresh  { refresh_token }
// ─────────────────────────────────────────────
app.post("/api/auth/refresh", async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token)
    return res.status(400).json({ error: "refresh_token이 없습니다." });

  try {
    const credentials = Buffer.from(
      `${CAFE24_CLIENT_ID}:${CAFE24_CLIENT_SECRET}`,
    ).toString("base64");
    const response = await axios.post(
      `${CAFE24_API_BASE}/oauth/token`,
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
      }).toString(),
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );
    return res.json(response.data);
  } catch (err) {
    return res
      .status(500)
      .json({ error: "토큰 갱신 실패", detail: err.response?.data });
  }
});

// ─────────────────────────────────────────────
// 핵심 API: 회원 쿠폰 목록 조회
//
// 카페24 원본 엔드포인트:
//   GET /api/v2/admin/customers/{member_id}/coupons
// 필요 Scope: mall.read_promotion
//
// 우리 백엔드 엔드포인트:
//   GET /api/coupons/:member_id
//   Header: Authorization: Bearer {access_token}
//   Query: shop_no (선택, default 1)
// ─────────────────────────────────────────────
app.get("/api/coupons/:member_id", async (req, res) => {
  const accessToken = req.headers.authorization?.replace("Bearer ", "");
  const { member_id } = req.params;
  const { shop_no = 1 } = req.query;

  if (!accessToken)
    return res.status(401).json({ error: "Access Token이 없습니다." });

  try {
    // 페이지네이션으로 전체 쿠폰 수집 (limit 최대 100)
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

      if (coupons.length < limit) break; // 마지막 페이지
      offset += limit;

      // 카페24 offset 최대값 10000 제한
      if (offset >= 10000) break;
    }

    // 정규화 + 만료 쿠폰 제외 (사용 가능한 것만)
    const normalized = allCoupons
      .map(normalizeCoupon)
      .filter((c) => c.validity.is_available); // 만료된 쿠폰 제외

    return res.json({
      member_id,
      shop_no,
      total_count: normalized.length,
      coupons: normalized,
    });
  } catch (err) {
    console.error("[쿠폰 조회 오류]", err.response?.data || err.message);

    if (err.response?.status === 401) {
      return res
        .status(401)
        .json({ error: "Access Token 만료", code: "TOKEN_EXPIRED" });
    }
    return res
      .status(500)
      .json({ error: "쿠폰 조회 실패", detail: err.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 서버 실행 중: http://localhost:${PORT}`);
});
