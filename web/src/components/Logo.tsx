// The CRM mark (design/logo/crm_logo.svg): three rising columns in the
// ProfitPad mark's slant and line width. Drawn in currentColor so each place
// that shows it picks the color (sidebar text, primary on light pages).
export function LogoMark({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-15.78 3.69 62.62 62.62" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="3.55" strokeLinejoin="miter" strokeMiterlimit="10">
        <polygon points="-10.779,54.000 -3.955,36.267 5.686,32.000 -2.779,54.000" />
        <polygon points="4.221,54.000 14.123,28.267 23.765,24.000 12.221,54.000" />
        <polygon points="19.221,54.000 32.201,20.267 41.843,16.000 27.221,54.000" />
      </g>
    </svg>
  );
}
