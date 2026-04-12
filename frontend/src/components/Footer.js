
import React from 'react';

const Footer = () => {
  return (
    <footer className="bg-gray-800 text-white py-8">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div>
            <h3 className="text-xl font-bold mb-4">About Us</h3>
            <p className="text-gray-400">
              We are a team of passionate developers dedicated to creating high-quality, scalable, and maintainable web applications.
            </p>
          </div>
          <div>
            <h3 className="text-xl font-bold mb-4">Quick Links</h3>
            <ul className="space-y-2">
              <li>
                <a href="/" className="hover:text-gray-300 transition-colors duration-300">Home</a>
              </li>
              <li>
                <a href="/about" className="hover:text-gray-300 transition-colors duration-300">About</a>
              </li>
              <li>
                <a href="/services" className="hover:text-gray-300 transition-colors duration-300">Services</a>
              </li>
              <li>
                <a href="/contact" className="hover:text-gray-300 transition-colors duration-300">Contact</a>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-xl font-bold mb-4">Follow Us</h3>
            <div className="flex space-x-4">
              <a href="https://facebook.com" className="text-gray-400 hover:text-white transition-colors duration-300">
                <i className="fab fa-facebook-f"></i>
              </a>
              <a href="https://twitter.com" className="text-gray-400 hover:text-white transition-colors duration-300">
                <i className="fab fa-twitter"></i>
              </a>
              <a href="https://linkedin.com" className="text-gray-400 hover:text-white transition-colors duration-300">
                <i className="fab fa-linkedin-in"></i>
              </a>
              <a href="https://instagram.com" className="text-gray-400 hover:text-white transition-colors duration-300">
                <i className="fab fa-instagram"></i>
              </a>
            </div>
          </div>
        </div>
        <div className="text-center text-gray-500 pt-8 mt-8 border-t border-gray-700">
          <p>&copy; {new Date().getFullYear()} Client Manager. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
