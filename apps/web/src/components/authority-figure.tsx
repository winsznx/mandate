/**
 * The hero figure: the one idea the product rests on, drawn once.
 *
 * The outer field is what a trial tested. The inner field is what the user
 * granted — always inside the tested one. A permitted call lands inside the
 * granted field; calls past its edge are struck through, refused by the account
 * before they are ever sent. No colour of its own: the warm ground it sits on
 * is the system's single saturated moment, and the marks are drawn in ink.
 */
const INK = "#1b0624";
const MUTE = "#766a7c";

export function AuthorityFigure() {
  return (
    <svg viewBox="0 0 460 360" role="img" aria-labelledby="authority-figure-title">
      <title id="authority-figure-title">
        The granted authority envelope drawn inside the tested one, with a permitted call inside it and two
        refused calls struck through outside it.
      </title>

      {/* tested envelope */}
      <rect
        x="20"
        y="28"
        width="420"
        height="304"
        rx="28"
        fill="none"
        stroke={INK}
        strokeOpacity="0.35"
        strokeWidth="1.5"
        strokeDasharray="2 5"
      />
      <text x="34" y="20" fill={MUTE} fontSize="13" fontFamily="var(--font-mono)">
        tested
      </text>

      {/* granted envelope */}
      <rect
        x="64"
        y="74"
        width="300"
        height="212"
        rx="22"
        fill="#ffffff"
        fillOpacity="0.55"
        stroke={INK}
        strokeWidth="1.75"
      />
      <text x="78" y="66" fill={INK} fontSize="13" fontFamily="var(--font-mono)">
        granted
      </text>

      {/* permitted call, inside */}
      <circle cx="176" cy="180" r="7" fill={INK} />
      <text x="196" y="184" fill={INK} fontSize="13" fontFamily="var(--font-mono)">
        repayBorrow · 20 USDT
      </text>

      {/* refused calls, outside the granted edge */}
      <g stroke={INK} strokeWidth="1.75">
        <line x1="386" y1="120" x2="404" y2="138" />
        <line x1="404" y1="120" x2="386" y2="138" />
      </g>
      <text x="300" y="114" fill={MUTE} fontSize="13" fontFamily="var(--font-mono)">
        +6 USDT
      </text>

      <g stroke={INK} strokeWidth="1.75">
        <line x1="392" y1="238" x2="410" y2="256" />
        <line x1="410" y1="238" x2="392" y2="256" />
      </g>
      <text x="286" y="232" fill={MUTE} fontSize="13" fontFamily="var(--font-mono)">
        wrong target
      </text>
    </svg>
  );
}
