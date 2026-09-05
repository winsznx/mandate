/**
 * The hero figure: the one idea the product rests on, drawn once.
 *
 * The outer field is what a trial tested. The inner field is what the user
 * granted — always inside the tested one. A permitted call lands inside the
 * granted field. A call that breaches the granted cap is refused even though
 * its shape was tested; a call outside the tested field was never in scope at
 * all. Both are struck through, refused by the account before they are sent.
 *
 * No colour of its own: the warm ground it sits on is the system's single
 * saturated moment, and every mark here is drawn in ink.
 */
const INK = "#1b0624";
const MUTE = "#6f6478";
const MONO = "var(--font-mono)";

export function AuthorityFigure() {
  return (
    <svg viewBox="0 0 520 384" role="img" aria-labelledby="authority-figure-title">
      <title id="authority-figure-title">
        The granted authority envelope drawn inside the tested one: a permitted repayment sits inside granted,
        a cap breach is refused inside tested but outside granted, and an out-of-scope call is refused outside
        tested entirely.
      </title>

      {/* tested envelope */}
      <text x="30" y="34" fill={MUTE} fontSize="13" fontFamily={MONO}>
        tested authority
      </text>
      <rect
        x="26"
        y="46"
        width="468"
        height="252"
        rx="26"
        fill="none"
        stroke={INK}
        strokeOpacity="0.32"
        strokeWidth="1.5"
        strokeDasharray="2 6"
      />

      {/* granted envelope */}
      <text x="58" y="92" fill={INK} fontSize="13" fontFamily={MONO}>
        granted
      </text>
      <rect
        x="54"
        y="104"
        width="272"
        height="150"
        rx="20"
        fill="#ffffff"
        fillOpacity="0.62"
        stroke={INK}
        strokeWidth="1.75"
      />

      {/* permitted call, inside granted */}
      <circle cx="82" cy="182" r="6.5" fill={INK} />
      <text x="100" y="187" fill={INK} fontSize="13.5" fontFamily={MONO}>
        repayBorrow · 20 USDT
      </text>

      {/* cap breach: inside tested, outside granted */}
      <text x="352" y="163" fill={MUTE} fontSize="13.5" fontFamily={MONO} textAnchor="start">
        +6 USDT
      </text>
      <g stroke={INK} strokeWidth="1.9" strokeLinecap="round">
        <line x1="437" y1="150" x2="453" y2="166" />
        <line x1="453" y1="150" x2="437" y2="166" />
      </g>

      {/* out of scope: outside tested entirely */}
      <g stroke={INK} strokeWidth="1.9" strokeLinecap="round">
        <line x1="60" y1="336" x2="76" y2="352" />
        <line x1="76" y1="336" x2="60" y2="352" />
      </g>
      <text x="90" y="349" fill={MUTE} fontSize="13.5" fontFamily={MONO}>
        wrong target · never in scope
      </text>
    </svg>
  );
}
