
import React from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
} from 'react-router-dom';
import Header from './components/Header';
import Footer from './components/Footer';
import AddClient from './components/AddClient';
import ClientList from './components/ClientList';

const Layout = ({ children }) => {
  return (
    <div className="flex flex-col min-h-screen">
      <Header />
      <main className="flex-grow">{children}</main>
      <Footer />
    </div>
  );
};

const App = () => {
  return (
    <Router>
      <Routes>
        <Route
          path="/"
          element={<Layout><AddClient /></Layout>}
        />
        <Route
          path="/clients"
          element={<Layout><ClientList /></Layout>}
        />
        <Route
          path="/about"
          element={<Layout><div>About Us</div></Layout>}
        />
        <Route
          path="/services"
          element={<Layout><div>Our Services</div></Layout>}
        />
        <Route
          path="/contact"
          element={<Layout><div>Contact Us</div></Layout>}
        />
      </Routes>
    </Router>
  );
};

export default App;
