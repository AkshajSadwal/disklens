/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Arial', 'Helvetica', 'sans-serif'],
      },
      boxShadow: {
        'dl-sidebar': '6px 0 18px rgba(12, 34, 70, .1)',
        'dl-soft': '0 7px 26px rgba(28, 62, 109, .07)',
        'dl-button': '0 6px 14px rgba(47, 115, 237, .15)',
      },
    },
  },
  plugins: [],
};
