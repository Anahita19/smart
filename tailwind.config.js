/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Deep navy — sidebar, hero card, primary text
        navy: {
          50: '#F1F4F9',
          100: '#E1E7F0',
          200: '#C3CEE0',
          300: '#98A9C6',
          400: '#6B82A8',
          500: '#4A6188',
          600: '#374B6D',
          700: '#2A3A56',
          800: '#1C2A42',
          900: '#121D31',
          950: '#0B1424',
        },
        // Warm neutral — page background and soft surfaces
        sand: {
          50: '#FBF9F5',
          100: '#F6F2EA',
          200: '#EDE6D8',
          300: '#DDD2BD',
          400: '#C7B89B',
          500: '#AD9A77',
        },
        // Muted gold — single accent colour
        gold: {
          400: '#D4B26A',
          500: '#C39A3E',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px rgb(11 20 36 / 0.04), 0 8px 24px -8px rgb(11 20 36 / 0.08)',
      },
    },
  },
  plugins: [],
};
