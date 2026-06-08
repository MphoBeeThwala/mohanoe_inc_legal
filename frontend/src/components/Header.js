
import React from 'react';
import { Link } from 'react-router-dom';

const Header = () => {
  return (
    <header className="bg-gray-800 text-white shadow-md">
      <div className="container mx-auto px-4 py-4 flex justify-between items-center">
        <Link to="/" className="text-2xl font-bold">Client Manager</Link>
        <nav>
          <ul className="flex space-x-4">
            <li>
              <Link to="/" className="hover:text-gray-300 transition-colors duration-300">Add Client</Link>
            </li>
            <li>
              <Link to="/clients" className="hover:text-gray-300 transition-colors duration-300">Client List</Link>
            </li>
            <li>
              <Link to="/about" className="hover:text-gray-300 transition-colors duration-300">About</Link>
            </li>
            <li>
              <Link to="/services" className="hover:text-gray-300 transition-colors duration-300">Services</Link>
            </li>
            <li>
              <Link to="/contact" className="hover:text-gray-300 transition-colors duration-300">Contact</Link>
            </li>
          </ul>
        </nav>
      </div>
    </header>
  );
};

export default Header;
