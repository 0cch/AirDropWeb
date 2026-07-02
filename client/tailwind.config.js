/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Arial', 'sans-serif']
      },
      colors: {
        apple: {
          blue: '#0071e3',
          'blue-hover': '#0077ed',
          gray: '#f5f5f7',
          'gray-dark': '#1d1d1f',
          'gray-text': '#6e6e73'
        }
      },
      borderRadius: {
        'apple-card': '20px',
        'apple-btn': '12px'
      }
    }
  },
  plugins: []
};
