
import React, { useState, useEffect } from 'react';
import axios from 'axios';

const ClientList = () => {
  const [clients, setClients] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchClients = async () => {
      try {
        const response = await axios.get('http://localhost:5000/api/clients');
        setClients(response.data);
        setLoading(false);
      } catch (error) {
        console.error('Error fetching clients:', error);
        setLoading(false);
      }
    };

    fetchClients();
  }, []);

  return (
    <div className="container mx-auto px-4 py-8">
      <h2 className="text-3xl font-bold mb-6 text-center">Client List</h2>
      <div className="bg-white shadow-md rounded-lg p-6">
        {loading ? (
          <p className="text-center text-gray-500">Loading...</p>
        ) : clients && clients.length > 0 ? (
          <ul className="space-y-4">
            {clients.map((client) => (
              <li key={client._id} className="border-b pb-4">
                <p className="text-lg font-semibold">{client.name}</p>
                <p className="text-gray-600">{client.email}</p>
                <p className="text-gray-600">{client.phone}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-center text-gray-500">No clients found.</p>
        )}
      </div>
    </div>
  );
};

export default ClientList;
